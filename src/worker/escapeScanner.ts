/**
 * Character-level state machines used by the sanitiser. Pure functions, no parsing.
 *
 * States: OUTSIDE_STRING → (") → IN_STRING → (\) → ESCAPE → IN_STRING …
 */

const BACKSLASH = 0x5c;
const QUOTE = 0x22;

const enum State {
  Outside,
  InString,
  Escape,
}

export interface EscapeScanResult {
  text: string;
  changed: boolean;
  /** literal \n \t \r \f \b turned into whitespace outside strings */
  convertedEscapes: number;
  /** trailing line-continuation backslashes removed */
  removedContinuations: number;
  /** raw control characters inside strings turned into JSON escapes */
  escapedControlChars: number;
}

/** What a literal two-character escape outside a string becomes. */
const OUTSIDE_ESCAPE: Record<string, string> = { n: '\n', t: '\t', r: '\n', f: ' ', b: ' ' };

const CONTROL_ESCAPE: Record<number, string> = {
  0x0a: '\\n',
  0x09: '\\t',
  0x0d: '\\r',
  0x08: '\\b',
  0x0c: '\\f',
};

/**
 * Turns literal two-character escapes (`\n`, `\t`, `\r`, `\f`, `\b`) that appear *between tokens* into
 * real whitespace. Inside strings they are valid JSON escapes and are kept untouched.
 *
 * In the same pass:
 * - a backslash directly before a real newline (or at the very end) outside a string is removed
 *   (shell/JS line continuations);
 * - raw control characters inside strings (e.g. a multi-line string pasted from a log) are turned
 *   into their JSON escapes, which JSON.parse would otherwise reject.
 */
export function scanLiteralEscapes(text: string): EscapeScanResult {
  const parts: string[] = [];
  let runStart = 0;
  let state = State.Outside;
  let convertedEscapes = 0;
  let removedContinuations = 0;
  let escapedControlChars = 0;
  const n = text.length;

  const flush = (to: number): void => {
    if (to > runStart) parts.push(text.slice(runStart, to));
  };

  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    switch (state) {
      case State.Outside:
        if (c === QUOTE) {
          state = State.InString;
        } else if (c === BACKSLASH) {
          const next = text[i + 1];
          const ws = next !== undefined ? OUTSIDE_ESCAPE[next] : undefined;
          if (ws !== undefined) {
            flush(i);
            parts.push(ws);
            convertedEscapes++;
            i++;
            runStart = i + 1;
          } else if (next === undefined || next === '\n') {
            flush(i);
            removedContinuations++;
            runStart = i + 1;
          }
        }
        break;
      case State.InString:
        if (c === BACKSLASH) state = State.Escape;
        else if (c === QUOTE) state = State.Outside;
        else if (c < 0x20) {
          flush(i);
          parts.push(CONTROL_ESCAPE[c] ?? `\\u${c.toString(16).padStart(4, '0')}`);
          escapedControlChars++;
          runStart = i + 1;
        }
        break;
      case State.Escape:
        state = State.InString;
        break;
    }
  }
  const changed = convertedEscapes + removedContinuations + escapedControlChars > 0;
  if (!changed) return { text, changed, convertedEscapes, removedContinuations, escapedControlChars };
  flush(n);
  return { text: parts.join(''), changed, convertedEscapes, removedContinuations, escapedControlChars };
}

/** True if every `"` in the text is written as `\"` (and at least one exists). */
export function allQuotesEscaped(text: string): boolean {
  let escaped = 0;
  for (let i = text.indexOf('"'); i !== -1; i = text.indexOf('"', i + 1)) {
    // count preceding backslashes; an odd count means this quote is escaped
    let b = 0;
    for (let j = i - 1; j >= 0 && text.charCodeAt(j) === BACKSLASH; j--) b++;
    if (b % 2 === 0) return false;
    escaped++;
  }
  return escaped > 0;
}

const UNESCAPE: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
};

/**
 * Removes exactly one level of escaping, leniently: like decoding the body of a JSON string literal,
 * but raw control characters (real newlines etc.) are allowed and kept as-is, and unknown escapes are
 * left alone.
 */
export function unescapeOneLevel(text: string): string {
  let i = text.indexOf('\\');
  if (i === -1) return text;
  const parts: string[] = [];
  let runStart = 0;
  while (i !== -1) {
    parts.push(text.slice(runStart, i));
    const next = text[i + 1];
    if (next === undefined) {
      runStart = i + 1;
      break;
    }
    const mapped = UNESCAPE[next];
    if (mapped !== undefined) {
      parts.push(mapped);
      runStart = i + 2;
    } else if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
      parts.push(String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)));
      runStart = i + 6;
    } else {
      parts.push('\\', next);
      runStart = i + 2;
    }
    i = text.indexOf('\\', runStart);
  }
  parts.push(text.slice(runStart));
  return parts.join('');
}

const INVISIBLE = /\u200B|\u200C|\u200D|\u2060|\uFEFF|\u00A0|\u202F/;

/**
 * Removes zero-width characters and turns non-breaking spaces into plain spaces, but only outside
 * strings, where they would break parsing. Inside strings they are part of the value.
 */
export function stripInvisibleOutsideStrings(text: string): { text: string; removed: number } {
  if (!INVISIBLE.test(text)) return { text, removed: 0 };
  const parts: string[] = [];
  let runStart = 0;
  let state = State.Outside;
  let removed = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (state === State.Outside) {
      if (c === QUOTE) state = State.InString;
      else if (c === 0x200b || c === 0x200c || c === 0x200d || c === 0x2060 || c === 0xfeff) {
        parts.push(text.slice(runStart, i));
        runStart = i + 1;
        removed++;
      } else if (c === 0x00a0 || c === 0x202f) {
        parts.push(text.slice(runStart, i), ' ');
        runStart = i + 1;
        removed++;
      }
    } else if (state === State.InString) {
      if (c === BACKSLASH) state = State.Escape;
      else if (c === QUOTE) state = State.Outside;
    } else {
      state = State.InString;
    }
  }
  parts.push(text.slice(runStart));
  return { text: parts.join(''), removed };
}

/** Counts lines (number of LF + 1) without allocating. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
  return lines;
}
