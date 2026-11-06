import { jsonrepair } from 'jsonrepair';
import { isSafeNumber, LosslessNumber, parse as losslessParse } from 'lossless-json';
import type { SanitizeError, SanitizeOptions, SanitizeResult } from '@shared/types';
import { locateJsonError } from './jsonError';
import {
  allQuotesEscaped,
  scanLiteralEscapes,
  stripInvisibleOutsideStrings,
  unescapeOneLevel,
} from './escapeScanner';

export const DEFAULT_SANITIZE_OPTIONS: SanitizeOptions = { expandNested: false, bigNumbers: true };

const MAX_UNWRAP = 5;

// ───────────────────────── parsing primitives ─────────────────────────

/**
 * Cheap pre-scan for number literals that a double can't hold exactly: 16+ consecutive digits or a
 * 3-digit exponent. Matches inside strings too; a false positive only costs a slower (still correct)
 * lossless parse, because the lossless number parser keeps safe numbers as plain numbers.
 */
const BIG_NUMBER_HINT = /\d{16,}|\d[eE][+-]?\d{3,}/;

export function mayContainBigNumbers(text: string): boolean {
  return BIG_NUMBER_HINT.test(text);
}

let bigCount = 0;
const losslessNumber = (s: string): number | LosslessNumber => {
  if (isSafeNumber(s)) return parseFloat(s);
  bigCount++;
  return new LosslessNumber(s);
};

type ParseOutcome = { ok: true; value: unknown; lossless: boolean } | { ok: false; error: Error };

export function tryParse(text: string, bigNumbers: boolean): ParseOutcome {
  try {
    if (bigNumbers && mayContainBigNumbers(text)) {
      try {
        bigCount = 0;
        const value = losslessParse(text, null, losslessNumber);
        // The pre-scan can match digits inside strings; only report lossless if a big number exists.
        return { ok: true, value, lossless: bigCount > 0 };
      } catch {
        // lossless-json is stricter (e.g. it rejects duplicate keys); fall back to the native parser.
      }
    }
    return { ok: true, value: JSON.parse(text), lossless: false };
  } catch (error) {
    return { ok: false, error: error as Error };
  }
}

// ───────────────────────── steps ─────────────────────────

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Step 0. BOM, trim, CRLF and invisible characters outside strings. */
export function normalize(input: string): { text: string; fixes: string[] } {
  const fixes: string[] = [];
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    fixes.push('Removed byte-order mark');
  }
  if (text.includes('\r')) {
    text = text.replace(/\r\n?/g, '\n');
    fixes.push('Normalised CRLF line endings');
  }
  text = text.trim();
  const inv = stripInvisibleOutsideStrings(text);
  if (inv.removed > 0) {
    text = inv.text.trim();
    fixes.push(`Removed ${plural(inv.removed, 'invisible character')} outside strings`);
  }
  return { text, fixes };
}

/** Step 2. Parses again while the value is a string that itself holds JSON. */
export function unwrapStringified(
  value: unknown,
  bigNumbers: boolean,
): { value: unknown; levels: number; lossless: boolean } {
  let levels = 0;
  let lossless = false;
  while (levels < MAX_UNWRAP && typeof value === 'string') {
    const t = value.trim();
    const looksJson =
      (t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']')) ||
      (t.length >= 2 && t.startsWith('"') && t.endsWith('"'));
    if (!looksJson) break;
    const r = tryParse(t, bigNumbers);
    if (!r.ok) break;
    value = r.value;
    lossless ||= r.lossless;
    levels++;
  }
  return { value, levels, lossless };
}

/** Step 3 heuristic: text copied from inside a string literal, e.g. `{\"a\":1}`. */
function looksLikeEscapedLiteral(text: string): boolean {
  return /^[{[]\s*\\"/.test(text) || (text.includes('\\"') && allQuotesEscaped(text));
}

/** Step 5 heuristic: everything escaped one extra level (`\\n`, `\\"`). */
function looksOverEscaped(text: string): boolean {
  return /\\\\["\\nrt]/.test(text);
}

interface Stripped {
  text: string;
  fixes: string[];
}

/** Step 6. Copy-paste debris around the JSON. Returns null if nothing was stripped. */
export function stripWrappers(input: string): Stripped | null {
  let text = input;
  const fixes: string[] = [];
  for (let guard = 0; guard < 6; guard++) {
    const before = text;
    let m: RegExpMatchArray | null;
    if ((m = text.match(/^```[\w+-]*[ \t]*\n?([\s\S]*?)\n?```$/))) {
      text = m[1].trim();
      fixes.push('Stripped Markdown code fence');
    } else if ((m = text.match(/^`([\s\S]*)`$/))) {
      text = m[1].trim();
      fixes.push('Stripped surrounding backticks');
    } else if (
      (m = text.match(
        /^(?:export\s+default\s+|module\.exports\s*=\s*|(?:var|let|const)\s+[\w$]+\s*=\s*)([\s\S]*)$/,
      ))
    ) {
      text = m[1].trim();
      fixes.push('Stripped variable assignment');
    } else if (text.endsWith(';')) {
      text = text.slice(0, -1).trim();
      fixes.push('Stripped trailing semicolon');
    } else if ((m = text.match(/^[\w$.]+\s*\(\s*([\s\S]*?)\s*\)$/))) {
      text = m[1];
      fixes.push('Stripped JSONP callback wrapper');
    }
    if (text === before) break;
  }
  // Log prefix / suffix: keep from the first { or [ to its matching last } or ].
  if (!/^[{["]/.test(text)) {
    const first = text.search(/[{[]/);
    if (first > 0) {
      const close = text[first] === '{' ? '}' : ']';
      const last = text.lastIndexOf(close);
      if (last > first) {
        text = text.slice(first, last + 1);
        fixes.push('Stripped log prefix before JSON');
      }
    }
  } else if (/^[{[]/.test(text)) {
    const close = text[0] === '{' ? '}' : ']';
    const last = text.lastIndexOf(close);
    if (last > 0 && last < text.length - 1 && /^[\s;,)]*\S/.test(text.slice(last + 1))) {
      // trailing junk after the closing bracket, e.g. "} (took 12ms)"
      text = text.slice(0, last + 1);
      fixes.push('Stripped trailing text after JSON');
    }
  }
  return fixes.length ? { text, fixes } : null;
}

/** Step 8. Several lines, each a JSON value on its own. */
function tryNdjson(
  text: string,
  bigNumbers: boolean,
): { value: unknown[]; lines: number; lossless: boolean } | null {
  if (!text.includes('\n')) return null;
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return null;
  const out: unknown[] = [];
  let lossless = false;
  for (const line of lines) {
    const r = tryParse(line.trim(), bigNumbers);
    if (!r.ok) return null;
    out.push(r.value);
    lossless ||= r.lossless;
  }
  return { value: out, lines: lines.length, lossless };
}

/** Option: replace string values holding JSON objects/arrays with the parsed value (iterative walk). */
export function expandNestedStrings(root: unknown, bigNumbers: boolean): { value: unknown; count: number } {
  let count = 0;
  const expand = (s: string): unknown => {
    const t = s.trim();
    if (!((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']')))) return undefined;
    const r = tryParse(t, bigNumbers);
    return r.ok && r.value !== null && typeof r.value === 'object' ? r.value : undefined;
  };
  if (typeof root === 'string') {
    const v = expand(root);
    if (v === undefined) return { value: root, count };
    root = v;
    count++;
  }
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object' || node instanceof LosslessNumber) continue;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === 'string') {
          const parsed = expand(v);
          if (parsed !== undefined) {
            node[i] = parsed;
            count++;
            stack.push(parsed);
          }
        } else stack.push(v);
      }
    } else {
      const obj = node as Record<string, unknown>;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === 'string') {
          const parsed = expand(v);
          if (parsed !== undefined) {
            obj[k] = parsed;
            count++;
            stack.push(parsed);
          }
        } else stack.push(v);
      }
    }
  }
  return { value: root, count };
}

// ───────────────────────── errors ─────────────────────────

/** 1-based line and column of an offset. */
export function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

const SNIPPET_SIDE = 40;

export function describeParseError(text: string, error?: Error): SanitizeError {
  // Our own validator knows the exact position; V8's message is only a fallback.
  const located = locateJsonError(text);
  const raw = located?.message ?? error?.message ?? 'Invalid JSON';
  let offset = located ? located.offset : text.length;
  if (!located) {
    const pos = raw.match(/at position (\d+)/);
    const lc = raw.match(/line (\d+) column (\d+)/);
    if (pos) offset = Number(pos[1]);
    else if (lc) {
      let o = 0;
      for (let k = 1; k < Number(lc[1]); k++) o = text.indexOf('\n', o) + 1;
      offset = o + Number(lc[2]) - 1;
    }
  }
  offset = Math.max(0, Math.min(offset, text.length));
  const { line, column } = lineCol(text, offset);

  const lineStart = offset - (column - 1);
  let lineEnd = text.indexOf('\n', offset);
  if (lineEnd === -1) lineEnd = text.length;
  const from = Math.max(lineStart, offset - SNIPPET_SIDE);
  const to = Math.min(lineEnd, offset + SNIPPET_SIDE);
  const prefix = from > lineStart ? '…' : '';
  const suffix = to < lineEnd ? '…' : '';
  const shown = text.slice(from, to).replace(/\t/g, ' ');
  const snippet = `${prefix}${shown}${suffix}\n${' '.repeat(prefix.length + (offset - from))}^`;

  const message = raw
    .replace(/\s*\(line \d+ column \d+\)/, '')
    .replace(/\s+in JSON at position \d+/, '')
    .replace(/\s+at position \d+/, '')
    .replace(/^JSON\.parse: /, '');
  return { message: message || 'Invalid JSON', line, column, offset, snippet };
}

// ───────────────────────── pipeline ─────────────────────────

/**
 * Turns messy, escaped, double-stringified or slightly broken JSON into a parsed value.
 * Steps run in order (plan.md §5.1); the first one that yields a valid parse wins.
 */
export function sanitize(input: string, options: Partial<SanitizeOptions> = {}): SanitizeResult {
  const opts = { ...DEFAULT_SANITIZE_OPTIONS, ...options };
  const big = opts.bigNumbers;
  const norm = normalize(input);
  const text = norm.text;

  // The text errors are reported against: what the editor shows (BOM stripped, LF line endings).
  const errorText = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).replace(/\r\n?/g, '\n');

  if (text === '') {
    return {
      ok: false,
      fixes: [],
      usedLossless: false,
      error: { message: 'Nothing to parse: the input is empty', line: 1, column: 1, offset: 0, snippet: '' },
    };
  }

  const finish = (value: unknown, lossless: boolean, stepFixes: string[]): SanitizeResult => {
    const fixes = [...norm.fixes, ...stepFixes];
    const un = unwrapStringified(value, big);
    if (un.levels > 0) fixes.push(`Unwrapped double-stringified JSON (${plural(un.levels, 'level')})`);
    let out = un.value;
    if (opts.expandNested) {
      const ex = expandNestedStrings(out, big);
      if (ex.count > 0) fixes.push(`Expanded ${plural(ex.count, 'nested stringified JSON field')}`);
      out = ex.value;
    }
    const usedLossless = lossless || un.lossless;
    if (usedLossless) fixes.push('Kept big numbers exactly (lossless parsing)');
    return { ok: true, value: out, fixes, usedLossless };
  };

  const attempt = (candidate: string, stepFixes: string[]): SanitizeResult | null => {
    const r = tryParse(candidate, big);
    return r.ok ? finish(r.value, r.lossless, stepFixes) : null;
  };

  // 1. direct parse (+ 2. unwrap, inside finish)
  const direct = attempt(text, []);
  if (direct) return direct;

  let working = text;
  let workingFixes: string[] = [];

  // 3. escaped string without its outer quotes: {\"a\":1}
  if (looksLikeEscapedLiteral(text)) {
    try {
      const inner = JSON.parse(`"${text}"`) as string;
      const r = attempt(inner, ['Unescaped JSON copied from a string literal']);
      if (r) return r;
      working = inner.trim();
      workingFixes = ['Unescaped JSON copied from a string literal'];
    } catch {
      /* not a valid string body; continue */
    }
  }

  // 4. literal escapes between tokens (state machine)
  const scan = scanLiteralEscapes(working);
  if (scan.changed) {
    const f: string[] = [];
    if (scan.convertedEscapes)
      f.push(
        `Converted ${plural(scan.convertedEscapes, 'literal escape sequence')} between tokens to whitespace`,
      );
    if (scan.removedContinuations)
      f.push(
        `Removed ${plural(scan.removedContinuations, 'line-continuation backslash', 'line-continuation backslashes')}`,
      );
    if (scan.escapedControlChars)
      f.push(`Escaped ${plural(scan.escapedControlChars, 'raw control character')} inside strings`);
    working = scan.text.trim();
    workingFixes = [...workingFixes, ...f];
    const r = attempt(working, workingFixes);
    if (r) return r;
  }
  // 4b. every structural quote written as \"
  if (allQuotesEscaped(working)) {
    const un = unescapeOneLevel(working);
    const f = [...workingFixes, 'Unescaped \\" structural quotes'];
    const r = attempt(un, f);
    if (r) return r;
    working = un;
    workingFixes = f;
  }

  // 5. over-escaped content (one extra level everywhere)
  if (looksOverEscaped(working)) {
    const r = attempt(unescapeOneLevel(working), [...workingFixes, 'Removed one level of over-escaping']);
    if (r) return r;
  }

  // 6. wrappers: var x =, JSONP, code fences, backticks, log prefixes
  const stripped = stripWrappers(working);
  if (stripped) {
    const r = attempt(stripped.text, [...workingFixes, ...stripped.fixes]);
    if (r) return r;
  }

  // 8 (before 7). NDJSON.
  // DECISION: the NDJSON check is cheap and exact, so it runs before the generic repair, which would
  // otherwise also accept NDJSON but report a vaguer "Repaired non-standard JSON".
  for (const cand of [working, stripped?.text]) {
    if (!cand) continue;
    const nd = tryNdjson(cand, big);
    if (nd) {
      return finish(nd.value, nd.lossless, [
        ...workingFixes,
        ...(cand === working ? [] : stripped!.fixes),
        `Parsed NDJSON (${plural(nd.lines, 'line')}) into an array`,
      ]);
    }
  }

  // 7. relaxed repair
  const repairCandidates: Array<[string, string[]]> = [];
  if (stripped) repairCandidates.push([stripped.text, [...workingFixes, ...stripped.fixes]]);
  repairCandidates.push([working, workingFixes]);
  if (working !== text) repairCandidates.push([text, []]);
  for (const [cand, f] of repairCandidates) {
    let repaired: string;
    try {
      repaired = jsonrepair(cand);
    } catch {
      continue;
    }
    // jsonrepair turns any prose into a JSON string ("<html>" → "\"<html>\""). That's not a repair.
    if (repaired.startsWith('"') && !cand.startsWith('"') && !cand.startsWith("'")) continue;
    const r = attempt(repaired, [...f, 'Repaired non-standard JSON']);
    if (r) return r;
  }

  // 9. give up, reporting the original text's parse error
  const err = tryParse(errorText, false);
  const error = describeParseError(errorText, err.ok ? undefined : err.error);
  return { ok: false, fixes: [], usedLossless: false, error };
}
