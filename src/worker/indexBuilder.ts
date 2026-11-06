import { isLosslessNumber } from 'lossless-json';
import { NodeFlag, NodeType, type StringTable, type TreeIndex } from '@shared/types';
import { INDEX_PROGRESS_EVERY, PREVIEW_MAX_CHARS } from '@shared/constants';

/** Growable UTF-16 string table. */
export class StringTableWriter {
  private data = new Uint16Array(1 << 16);
  private offsets = new Uint32Array(1 << 12);
  private len = 0;
  private count = 0;

  /** Appends a string and returns its index. */
  push(s: string): number {
    if (this.count + 2 > this.offsets.length) {
      const o = new Uint32Array(this.offsets.length * 2);
      o.set(this.offsets);
      this.offsets = o;
    }
    const need = this.len + s.length;
    if (need > this.data.length) {
      let cap = this.data.length * 2;
      while (cap < need) cap *= 2;
      const d = new Uint16Array(cap);
      d.set(this.data.subarray(0, this.len));
      this.data = d;
    }
    const d = this.data;
    let p = this.len;
    for (let i = 0; i < s.length; i++) d[p++] = s.charCodeAt(i);
    this.offsets[this.count] = this.len;
    this.len = p;
    this.offsets[++this.count] = p;
    return this.count - 1;
  }

  finish(): StringTable {
    return { data: this.data.slice(0, this.len), offsets: this.offsets.slice(0, this.count + 1) };
  }
}

/** Reads string i from a StringTable. */
export function tableString(t: StringTable, i: number): string {
  const start = t.offsets[i];
  const end = t.offsets[i + 1];
  if (end - start < 4096)
    return String.fromCharCode.apply(null, t.data.subarray(start, end) as unknown as number[]);
  let out = '';
  for (let p = start; p < end; p += 4096) {
    out += String.fromCharCode.apply(
      null,
      t.data.subarray(p, Math.min(end, p + 4096)) as unknown as number[],
    );
  }
  return out;
}

export function packStrings(list: string[]): StringTable {
  const w = new StringTableWriter();
  for (const s of list) w.push(s);
  return w.finish();
}

class Columns {
  cap: number;
  type: Uint8Array;
  depth: Uint16Array;
  parent: Int32Array;
  subtreeEnd: Int32Array;
  childCount: Int32Array;
  keyId: Int32Array;
  arrayIndex: Int32Array;
  flags: Uint8Array;

  constructor(cap: number) {
    this.cap = cap;
    this.type = new Uint8Array(cap);
    this.depth = new Uint16Array(cap);
    this.parent = new Int32Array(cap);
    this.subtreeEnd = new Int32Array(cap);
    this.childCount = new Int32Array(cap);
    this.keyId = new Int32Array(cap);
    this.arrayIndex = new Int32Array(cap);
    this.flags = new Uint8Array(cap);
  }

  grow(): void {
    const next = new Columns(this.cap * 2);
    next.type.set(this.type);
    next.depth.set(this.depth);
    next.parent.set(this.parent);
    next.subtreeEnd.set(this.subtreeEnd);
    next.childCount.set(this.childCount);
    next.keyId.set(this.keyId);
    next.arrayIndex.set(this.arrayIndex);
    next.flags.set(this.flags);
    Object.assign(this, next);
  }
}

interface Frame {
  id: number;
  value: Record<string, unknown> | unknown[];
  keys: string[] | null;
  i: number;
  len: number;
  depth: number;
}

export interface BuiltIndex {
  index: TreeIndex;
  /** unique keys as plain strings (kept by the worker for search/paths) */
  keyList: string[];
  /**
   * node id → value (primitives, or references to containers).
   * DECISION: plan.md §6 finds a node by following parent/key links from the root. Keeping one
   * reference per node costs 8 bytes/node and makes getValue, search and CSV source lookup O(1).
   */
  values: unknown[];
}

/** Truncates to PREVIEW_MAX_CHARS without splitting a surrogate pair. */
function truncate(s: string): string {
  let end = PREVIEW_MAX_CHARS;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/**
 * Builds the flat pre-order index in one walk with an explicit stack (no recursion, so depth can't
 * overflow). Calls onProgress(pct) about every INDEX_PROGRESS_EVERY nodes.
 */
export function buildIndex(root: unknown, onProgress?: (pct: number) => void): BuiltIndex {
  let cols = new Columns(1 << 14);
  const previews = new StringTableWriter();
  const keyIds = new Map<string, number>();
  const keyList: string[] = [];
  const stack: Frame[] = [];
  const values: unknown[] = [];
  let n = 0;
  let maxDepth = 0;

  const intern = (k: string): number => {
    let id = keyIds.get(k);
    if (id === undefined) {
      id = keyList.length;
      keyIds.set(k, id);
      keyList.push(k);
    }
    return id;
  };

  const emit = (v: unknown, keyId: number, arrayIndex: number, parent: number, depth: number): void => {
    if (n === cols.cap) cols.grow();
    const id = n++;
    values.push(v);
    const c = cols;
    c.parent[id] = parent;
    c.keyId[id] = keyId;
    c.arrayIndex[id] = arrayIndex;
    c.depth[id] = depth > 0xffff ? 0xffff : depth;
    if (depth > maxDepth) maxDepth = depth;

    let preview = '';
    if (v === null || v === undefined) {
      c.type[id] = NodeType.Null;
      preview = 'null';
    } else if (Array.isArray(v)) {
      c.type[id] = NodeType.Array;
      c.childCount[id] = v.length;
      if (v.length) stack.push({ id, value: v, keys: null, i: 0, len: v.length, depth });
    } else if (typeof v === 'object') {
      if (isLosslessNumber(v)) {
        c.type[id] = NodeType.BigNumber;
        preview = v.value;
      } else {
        const keys = Object.keys(v);
        c.type[id] = NodeType.Object;
        c.childCount[id] = keys.length;
        if (keys.length)
          stack.push({ id, value: v as Record<string, unknown>, keys, i: 0, len: keys.length, depth });
      }
    } else if (typeof v === 'string') {
      c.type[id] = NodeType.String;
      if (v.length > PREVIEW_MAX_CHARS) {
        preview = truncate(v);
        c.flags[id] = NodeFlag.Truncated;
      } else preview = v;
    } else if (typeof v === 'number') {
      c.type[id] = NodeType.Number;
      preview = String(v);
    } else if (typeof v === 'boolean') {
      c.type[id] = NodeType.Boolean;
      preview = v ? 'true' : 'false';
    } else {
      c.type[id] = NodeType.Null;
      preview = 'null';
    }
    previews.push(preview);
    // Leaves and empty containers end right after themselves; non-empty containers are closed on pop.
    if (stack.length === 0 || stack[stack.length - 1].id !== id) c.subtreeEnd[id] = id + 1;
  };

  emit(root, -1, -1, -1, 0);
  let nextProgress = INDEX_PROGRESS_EVERY;
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.i < f.len) {
      const i = f.i++;
      if (f.keys) {
        const k = f.keys[i];
        emit((f.value as Record<string, unknown>)[k], intern(k), -1, f.id, f.depth + 1);
      } else {
        emit((f.value as unknown[])[i], -1, i, f.id, f.depth + 1);
      }
      if (n >= nextProgress && onProgress) {
        nextProgress += INDEX_PROGRESS_EVERY;
        const top = stack[0];
        const second = stack[1];
        let pct = top.i / top.len;
        if (second && top.len > 0) pct = (top.i - 1 + second.i / second.len) / top.len;
        onProgress(Math.max(0, Math.min(99, Math.round(pct * 100))));
      }
    } else {
      cols.subtreeEnd[f.id] = n;
      stack.pop();
    }
  }

  const c = cols;
  cols = undefined as unknown as Columns;
  const index: TreeIndex = {
    n,
    type: c.type.slice(0, n),
    depth: c.depth.slice(0, n),
    parent: c.parent.slice(0, n),
    subtreeEnd: c.subtreeEnd.slice(0, n),
    childCount: c.childCount.slice(0, n),
    keyId: c.keyId.slice(0, n),
    arrayIndex: c.arrayIndex.slice(0, n),
    flags: c.flags.slice(0, n),
    keys: packStrings(keyList),
    preview: previews.finish(),
    maxDepth,
  };
  return { index, keyList, values };
}

/** All typed-array buffers of an index, for postMessage transfer lists. */
export function indexTransferables(idx: TreeIndex): ArrayBuffer[] {
  return [
    idx.type,
    idx.depth,
    idx.parent,
    idx.subtreeEnd,
    idx.childCount,
    idx.keyId,
    idx.arrayIndex,
    idx.flags,
    idx.keys.data,
    idx.keys.offsets,
    idx.preview.data,
    idx.preview.offsets,
  ].map((a) => a.buffer as ArrayBuffer);
}
