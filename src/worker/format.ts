import { isLosslessNumber } from 'lossless-json';
import type { Indent } from '@shared/types';
import { EXPORT_CHUNK_CHARS } from '@shared/constants';

export function indentString(indent: Indent, minify: boolean): string {
  if (minify) return '';
  return indent === '\t' ? '\t' : ' '.repeat(indent);
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === 'object' && !isLosslessNumber(v);
}

/** Returns a copy of the value with object keys sorted alphabetically at every level (iterative). */
export function sortKeysDeep(root: unknown): unknown {
  if (!isContainer(root)) return root;
  const copy = (v: Record<string, unknown> | unknown[]): Record<string, unknown> | unknown[] =>
    Array.isArray(v) ? new Array(v.length) : {};
  const out = copy(root);
  const stack: Array<[Record<string, unknown> | unknown[], Record<string, unknown> | unknown[]]> = [
    [root, out],
  ];
  while (stack.length) {
    const [src, dst] = stack.pop()!;
    if (Array.isArray(src)) {
      const d = dst as unknown[];
      for (let i = 0; i < src.length; i++) {
        const v = src[i];
        if (isContainer(v)) {
          const c = copy(v);
          d[i] = c;
          stack.push([v, c]);
        } else d[i] = v;
      }
    } else {
      const d = dst as Record<string, unknown>;
      for (const k of Object.keys(src).sort()) {
        const v = src[k];
        if (isContainer(v)) {
          const c = copy(v);
          d[k] = c;
          stack.push([v, c]);
        } else d[k] = v;
      }
    }
  }
  return out;
}

function primitive(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (isLosslessNumber(v)) return v.value;
  // numbers (NaN/Infinity → null, like JSON.stringify), booleans, null
  return JSON.stringify(v) ?? 'null';
}

interface Frame {
  value: Record<string, unknown> | unknown[];
  keys: string[] | null;
  i: number;
  len: number;
  depth: number;
}

/**
 * Iterative serialiser that produces the same text as JSON.stringify(value, null, indent), but:
 * - writes LosslessNumber values as their exact original digits,
 * - never recurses (depth can't overflow the stack),
 * - yields the output in chunks of about `chunkChars`, so huge documents never become one string.
 */
export function* serialize(
  root: unknown,
  indent: string,
  chunkChars = EXPORT_CHUNK_CHARS,
): Generator<string> {
  const colon = indent ? ': ' : ':';
  const newlines: string[] = [];
  const nl = (depth: number): string => {
    if (!indent) return '';
    return (newlines[depth] ??= '\n' + indent.repeat(depth));
  };
  let buf = '';
  const stack: Frame[] = [];

  const open = (v: unknown, depth: number): void => {
    if (!isContainer(v)) {
      buf += primitive(v);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) buf += '[]';
      else {
        buf += '[';
        stack.push({ value: v, keys: null, i: 0, len: v.length, depth });
      }
    } else {
      const keys = Object.keys(v);
      if (keys.length === 0) buf += '{}';
      else {
        buf += '{';
        stack.push({ value: v, keys, i: 0, len: keys.length, depth });
      }
    }
  };

  open(root, 0);
  while (stack.length) {
    const f = stack[stack.length - 1];
    if (f.i < f.len) {
      if (f.i > 0) buf += ',';
      buf += nl(f.depth + 1);
      let child: unknown;
      if (f.keys) {
        const k = f.keys[f.i];
        buf += JSON.stringify(k) + colon;
        child = (f.value as Record<string, unknown>)[k];
      } else child = (f.value as unknown[])[f.i];
      f.i++;
      open(child, f.depth + 1);
    } else {
      buf += nl(f.depth) + (f.keys ? '}' : ']');
      stack.pop();
    }
    if (buf.length >= chunkChars) {
      yield buf;
      buf = '';
    }
  }
  if (buf) yield buf;
}

/** Formats a value as text. Uses native JSON.stringify unless big numbers need exact output. */
export function formatJson(value: unknown, indent: Indent, minify: boolean, lossless: boolean): string {
  const ind = indentString(indent, minify);
  if (!lossless) return JSON.stringify(value, null, ind || undefined) ?? 'null';
  let out = '';
  for (const chunk of serialize(value, ind, 8 * 1024 * 1024)) out += chunk;
  return out;
}

/** Formats a single node value for display/copying: primitives as their plain text. */
export function valueToText(value: unknown, indent: Indent): string {
  if (typeof value === 'string') return value;
  if (isContainer(value)) return formatJson(value, indent, false, true);
  return primitive(value);
}
