import type { ReactNode } from 'react';
import type { SearchOptions } from '@shared/types';

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Display-only regex mirroring the worker's matcher (search.ts), with the global flag. */
export function buildHighlighter(query: string, opts: SearchOptions): RegExp | null {
  if (!query) return null;
  try {
    let src = opts.regex ? query : escapeRegExp(query);
    if (opts.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
    const re = new RegExp(src, opts.caseSensitive ? 'gu' : 'giu');
    // a regex that matches the empty string would loop forever
    if (re.test('')) return null;
    return re;
  } catch {
    return null;
  }
}

/** Wraps matches of `re` in <mark>. */
export function highlight(text: string, re: RegExp | null, markClass: string): ReactNode {
  if (!re || !text) return text;
  re.lastIndex = 0;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 50) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <mark key={m.index} className={markClass}>
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
