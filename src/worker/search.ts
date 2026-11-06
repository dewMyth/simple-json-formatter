import { isLosslessNumber } from 'lossless-json';
import { NodeType, type SearchOptions, type SearchResult } from '@shared/types';
import { SEARCH_RESULT_CAP } from '@shared/constants';

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  keys: true,
  values: true,
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Builds a predicate for one search query. Throws a SyntaxError for an invalid regex. */
export function buildMatcher(query: string, opts: SearchOptions): (s: string) => boolean {
  if (opts.regex || opts.wholeWord) {
    let src = opts.regex ? query : escapeRegExp(query);
    // \b is ASCII-only; use Unicode-aware word boundaries.
    if (opts.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    const re = new RegExp(src, opts.caseSensitive ? 'u' : 'iu');
    return (s) => re.test(s);
  }
  if (opts.caseSensitive) return (s) => s.includes(query);
  const q = query.toLowerCase();
  return (s) => s.toLowerCase().includes(q);
}

export function primitiveText(v: unknown, type: number): string | null {
  switch (type) {
    case NodeType.String:
      return v as string;
    case NodeType.Number:
      return String(v);
    case NodeType.Boolean:
      return v ? 'true' : 'false';
    case NodeType.Null:
      return 'null';
    case NodeType.BigNumber:
      return isLosslessNumber(v) ? v.value : String(v);
    default:
      return null;
  }
}

export interface SearchInput {
  n: number;
  type: Uint8Array;
  keyId: Int32Array;
  keyList: string[];
  values: unknown[];
}

/**
 * Searches keys and/or values. A generator so the worker can yield to its event loop between slices
 * (and notice a cancel); it yields every `sliceNodes` nodes and returns the result.
 */
export function* searchIter(
  input: SearchInput,
  query: string,
  opts: SearchOptions,
  cap = SEARCH_RESULT_CAP,
  sliceNodes = 20_000,
): Generator<number, SearchResult> {
  if (query === '' || (!opts.keys && !opts.values)) return { ids: new Int32Array(0), more: false };
  const match = buildMatcher(query, opts);
  const keyMatch = new Uint8Array(input.keyList.length);
  if (opts.keys) for (let k = 0; k < input.keyList.length; k++) keyMatch[k] = match(input.keyList[k]) ? 1 : 0;

  const out = new Int32Array(Math.min(cap, input.n));
  let found = 0;
  let more = false;
  const { type, keyId, values } = input;
  for (let i = 0; i < input.n; i++) {
    let hit = false;
    if (opts.keys) {
      const k = keyId[i];
      hit = k >= 0 && keyMatch[k] === 1;
    }
    if (!hit && opts.values && type[i] > NodeType.Array) {
      const text = primitiveText(values[i], type[i]);
      hit = text !== null && match(text);
    }
    if (hit) {
      if (found === cap) {
        more = true;
        break;
      }
      out[found++] = i;
    }
    if (i % sliceNodes === sliceNodes - 1) yield i;
  }
  return { ids: out.slice(0, found), more };
}

/** Runs a search to completion synchronously. */
export function search(input: SearchInput, query: string, opts: SearchOptions, cap?: number): SearchResult {
  const it = searchIter(input, query, opts, cap);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}
