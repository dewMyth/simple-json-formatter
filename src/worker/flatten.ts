import { isLosslessNumber } from 'lossless-json';
import type { CsvExplodeCandidate, FlattenOptions } from '@shared/types';
import { formatJson } from './format';

export const DEFAULT_FLATTEN_OPTIONS: FlattenOptions = {
  separator: '.',
  maxDepth: 0,
  arrayMode: 'auto',
  arrayOverrides: {},
  joinSeparator: '; ',
  indexCap: 50,
  explodePath: null,
};

export function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== 'object' || isLosslessNumber(v);
}

type Container = Record<string, unknown> | unknown[];

export interface FlattenContext {
  opts: FlattenOptions;
  /** formats a primitive value as cell text (nulls, booleans, big numbers…) */
  fmt: (v: unknown) => string;
}

/** Column name used for a primitive record (array of primitives) or a primitive root. */
export const VALUE_COLUMN = 'value';

/** Deep values beyond maxDepth, and arrays in 'json' mode, are written as JSON text. */
function jsonText(v: unknown): string {
  return formatJson(v, 2, true, true);
}

function flattenInto(
  out: Map<string, string>,
  value: unknown,
  path: string,
  generic: string,
  depth: number,
  ctx: FlattenContext,
): void {
  const { opts } = ctx;
  if (isPrimitive(value)) {
    out.set(path || VALUE_COLUMN, ctx.fmt(value));
    return;
  }
  if (path !== '' && ((opts.maxDepth > 0 && depth >= opts.maxDepth) || depth > 1000)) {
    out.set(path, jsonText(value));
    return;
  }
  if (Array.isArray(value)) {
    let mode = opts.arrayOverrides[generic] ?? opts.arrayMode;
    const allPrimitive = value.every(isPrimitive);
    if (mode === 'auto') mode = allPrimitive ? 'join' : 'json';
    const key = path || VALUE_COLUMN;
    if (mode === 'join') {
      out.set(key, value.map((v) => (isPrimitive(v) ? ctx.fmt(v) : jsonText(v))).join(opts.joinSeparator));
    } else if (mode === 'json') {
      out.set(key, jsonText(value));
    } else {
      // index: one column per element, capped
      const n = Math.min(value.length, opts.indexCap);
      for (let i = 0; i < n; i++) {
        flattenInto(
          out,
          value[i],
          path ? `${path}${opts.separator}${i}` : String(i),
          generic,
          depth + 1,
          ctx,
        );
      }
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) {
    if (path !== '') out.set(path, '{}');
    return;
  }
  for (const k of keys) {
    flattenInto(
      out,
      obj[k],
      path ? `${path}${opts.separator}${k}` : k,
      generic ? `${generic}.${k}` : k,
      depth + 1,
      ctx,
    );
  }
}

/** Flattens one record into column → cell text. Column names use the configured separator. */
export function flattenRecord(record: unknown, ctx: FlattenContext): Map<string, string> {
  const out = new Map<string, string>();
  flattenInto(out, record, '', '', 0, ctx);
  return out;
}

function getAt(v: unknown, segments: string[]): unknown {
  let cur = v;
  for (const s of segments) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

/** Shallow-copies objects along the path and sets the leaf (undefined deletes it). */
function setAt(v: Record<string, unknown>, segments: string[], leaf: unknown): Record<string, unknown> {
  const root = { ...v };
  let cur = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const next = cur[segments[i]];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return root;
    const copy = { ...(next as Record<string, unknown>) };
    cur[segments[i]] = copy;
    cur = copy;
  }
  const last = segments[segments.length - 1];
  if (leaf === undefined) Reflect.deleteProperty(cur, last);
  else cur[last] = leaf;
  return root;
}

/**
 * 'explode': one row per element of the array at `segments`, with the parent fields repeated.
 * Records without the array (or with an empty one) produce one row without it.
 */
export function explodeRecord(record: unknown, segments: string[]): unknown[] {
  if (record === null || typeof record !== 'object' || Array.isArray(record) || isLosslessNumber(record)) {
    return [record];
  }
  const arr = getAt(record, segments);
  const rec = record as Record<string, unknown>;
  if (!Array.isArray(arr)) return [record];
  if (arr.length === 0) return [setAt(rec, segments, undefined)];
  return arr.map((el) => setAt(rec, segments, el));
}

export function explodedRowCount(record: unknown, segments: string[]): number {
  const arr = getAt(record, segments);
  return Array.isArray(arr) && arr.length > 0 ? arr.length : 1;
}

/**
 * Looks at the first `sample` records for arrays: object-only paths (explode candidates) and generic
 * paths of every array (for per-path overrides).
 */
export function findArrays(
  records: unknown[],
  separator: string,
  sample = 1000,
): { explode: CsvExplodeCandidate[]; arrayPaths: string[] } {
  const explode = new Map<string, string[]>();
  const generic = new Set<string>();
  const n = Math.min(records.length, sample);
  for (let r = 0; r < n; r++) {
    const stack: Array<[unknown, string[], string, boolean]> = [[records[r], [], '', true]];
    while (stack.length) {
      const [v, segs, gen, viaObjects] = stack.pop()!;
      if (isPrimitive(v)) continue;
      if (Array.isArray(v)) {
        if (gen !== '') {
          generic.add(gen);
          if (viaObjects) explode.set(segs.join('\u0000'), segs);
        }
        for (const el of v.slice(0, 50)) stack.push([el, segs, gen, false]);
      } else {
        for (const k of Object.keys(v as Container)) {
          stack.push([(v as Record<string, unknown>)[k], [...segs, k], gen ? `${gen}.${k}` : k, viaObjects]);
        }
      }
      if (stack.length > 10_000) break;
    }
  }
  return {
    explode: [...explode.values()].map((segments) => ({ segments, label: segments.join(separator) })),
    arrayPaths: [...generic].sort(),
  };
}
