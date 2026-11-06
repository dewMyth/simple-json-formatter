import { NodeFlag, NodeType, type StringTable, type TreeIndex } from '@shared/types';
import { jsonPath } from '@shared/path';

/** Visible rows in pre-order, skipping collapsed subtrees. O(visible rows). */
export function computeVisible(idx: TreeIndex, expanded: Uint8Array): Int32Array {
  const out = new Int32Array(idx.n);
  let k = 0;
  let i = 0;
  while (i < idx.n) {
    out[k++] = i;
    const container = idx.type[i] <= NodeType.Array;
    i = container && !expanded[i] ? idx.subtreeEnd[i] : i + 1;
  }
  return out.subarray(0, k);
}

export function tableString(t: StringTable, i: number): string {
  const start = t.offsets[i];
  const end = t.offsets[i + 1];
  if (end === start) return '';
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

const keyCaches = new WeakMap<TreeIndex, Array<string | undefined>>();

/** Decoded property name for a key id (cached per index). */
export function keyName(idx: TreeIndex, keyId: number): string {
  let cache = keyCaches.get(idx);
  if (!cache) {
    cache = [];
    keyCaches.set(idx, cache);
  }
  return (cache[keyId] ??= tableString(idx.keys, keyId));
}

/** Property name of a node, or null for array items and the root. */
export function getKey(idx: TreeIndex, i: number): string | null {
  const k = idx.keyId[i];
  return k >= 0 ? keyName(idx, k) : null;
}

/** Label shown in the tree: the key, `[index]` for array items, or "root". */
export function getLabel(idx: TreeIndex, i: number): string {
  if (i === 0) return 'root';
  const k = getKey(idx, i);
  return k ?? String(idx.arrayIndex[i]);
}

export function isContainer(idx: TreeIndex, i: number): boolean {
  return idx.type[i] <= NodeType.Array;
}

export function isTruncated(idx: TreeIndex, i: number): boolean {
  return (idx.flags[i] & NodeFlag.Truncated) !== 0;
}

/** Raw preview text of a primitive (truncated strings end early — see isTruncated). */
export function getPreview(idx: TreeIndex, i: number): string {
  return tableString(idx.preview, i);
}

/** `{12}` / `[3400]` for containers. */
export function containerSummary(idx: TreeIndex, i: number): string {
  const n = idx.childCount[i].toLocaleString('en-US');
  return idx.type[i] === NodeType.Object ? `{${n}}` : `[${n}]`;
}

/** Display text for a value: strings quoted with escapes visible, others as-is. */
export function displayValue(idx: TreeIndex, i: number): string {
  const t = idx.type[i];
  if (t <= NodeType.Array) return containerSummary(idx, i);
  const p = getPreview(idx, i);
  if (t === NodeType.String) {
    const quoted = JSON.stringify(p);
    return isTruncated(idx, i) ? `${quoted.slice(0, -1)}…"` : quoted;
  }
  return p;
}

export function pathOf(idx: TreeIndex, i: number): string {
  return jsonPath(idx, i, (k) => keyName(idx, k));
}

/** Default view: the root and its first level are expanded. */
export function defaultExpanded(idx: TreeIndex): Uint8Array {
  return expandToLevel(idx, new Uint8Array(idx.n), 2);
}

/** Expands nodes with depth < level and collapses the rest. One linear pass. */
export function expandToLevel(idx: TreeIndex, expanded: Uint8Array, level: number): Uint8Array {
  const { depth, type, n } = idx;
  for (let i = 0; i < n; i++) expanded[i] = type[i] <= NodeType.Array && depth[i] < level ? 1 : 0;
  return expanded;
}

export function setAll(idx: TreeIndex, expanded: Uint8Array, value: 0 | 1): Uint8Array {
  if (value === 0) expanded.fill(0);
  else for (let i = 0; i < idx.n; i++) expanded[i] = idx.type[i] <= NodeType.Array ? 1 : 0;
  return expanded;
}

/** Expands or collapses a node and its whole subtree. */
export function setSubtree(idx: TreeIndex, expanded: Uint8Array, i: number, value: 0 | 1): void {
  const end = idx.subtreeEnd[i];
  for (let j = i; j < end; j++) if (idx.type[j] <= NodeType.Array) expanded[j] = value;
}

/** Expands every ancestor of a node so it becomes visible. Returns true if anything changed. */
export function expandAncestors(idx: TreeIndex, expanded: Uint8Array, i: number): boolean {
  let changed = false;
  for (let p = idx.parent[i]; p >= 0; p = idx.parent[p]) {
    if (!expanded[p]) {
      expanded[p] = 1;
      changed = true;
    }
  }
  return changed;
}

/** Position of node id in the (sorted) visible list, or -1. */
export function rowOf(visible: Int32Array, id: number): number {
  let lo = 0;
  let hi = visible.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = visible[mid];
    if (v === id) return mid;
    if (v < id) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Direct children of a node, read from the index by jumping over subtrees. */
export function childrenOf(idx: TreeIndex, i: number): Int32Array {
  const out = new Int32Array(idx.childCount[i]);
  let k = 0;
  const end = idx.subtreeEnd[i];
  for (let c = i + 1; c < end; c = idx.subtreeEnd[c]) out[k++] = c;
  return out.subarray(0, k);
}

const units = ['B', 'KB', 'MB', 'GB'];
export function formatBytes(b: number): string {
  let u = 0;
  let v = b;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

export const fmtInt = (n: number): string => n.toLocaleString('en-US');
