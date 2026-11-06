import {
  allQuotesEscaped,
  countLines,
  scanLiteralEscapes,
  stripInvisibleOutsideStrings,
  unescapeOneLevel,
} from './escapeScanner';

const raw = String.raw;

describe('scanLiteralEscapes', () => {
  it('converts literal escapes outside strings and keeps them inside', () => {
    const r = scanLiteralEscapes(raw`{\n\t"a": "x\ny",\r\n"b":1}`);
    expect(r.text).toBe('{\n\t"a": "x\\ny",\n\n"b":1}');
    expect(r.convertedEscapes).toBe(4);
    expect(r.changed).toBe(true);
  });

  it('handles \\f and \\b outside strings', () => {
    expect(scanLiteralEscapes(raw`[1,\f2,\b3]`).text).toBe('[1, 2, 3]');
  });

  it('keeps escaped quotes inside strings', () => {
    const s = raw`{"a": "say \"hi\" \n"}`;
    expect(scanLiteralEscapes(s)).toMatchObject({ text: s, changed: false });
  });

  it('removes line continuations (backslash before newline or at end)', () => {
    const r = scanLiteralEscapes('{"a":1, \\\n"b":2}\\');
    expect(r.text).toBe('{"a":1, \n"b":2}');
    expect(r.removedContinuations).toBe(2);
  });

  it('escapes raw control characters inside strings', () => {
    const r = scanLiteralEscapes('{"a":"l1\nl2\tx\u0001"}');
    expect(r.text).toBe('{"a":"l1\\nl2\\tx\\u0001"}');
    expect(r.escapedControlChars).toBe(3);
  });

  it('leaves other backslashes outside strings alone', () => {
    expect(scanLiteralEscapes(raw`{\u0020}`).text).toBe(raw`{\u0020}`);
  });

  it('returns the same string instance when nothing changes', () => {
    const s = '{"a": [1, 2, 3]}';
    expect(scanLiteralEscapes(s).text).toBe(s);
  });
});

describe('allQuotesEscaped', () => {
  it('detects fully escaped quotes', () => {
    expect(allQuotesEscaped(raw`{\"a\":1}`)).toBe(true);
    expect(allQuotesEscaped(raw`{"a":1}`)).toBe(false);
    expect(allQuotesEscaped(raw`{\\"a\\":1}`)).toBe(false);
    expect(allQuotesEscaped('{}')).toBe(false);
  });
});

describe('unescapeOneLevel', () => {
  it('removes one level of escaping', () => {
    expect(unescapeOneLevel(raw`{\"a\":\"x\\ny\"}`)).toBe(raw`{"a":"x\ny"}`);
    expect(unescapeOneLevel(raw`\u0041\/\t\r\b\f`)).toBe('A/\t\r\b\f');
  });
  it('keeps unknown escapes and a trailing backslash is dropped', () => {
    expect(unescapeOneLevel(raw`a\qb\\`)).toBe(raw`a\qb\\`.replace(/\\\\$/, '\\'));
    expect(unescapeOneLevel('abc\\')).toBe('abc');
    expect(unescapeOneLevel('plain')).toBe('plain');
  });
});

describe('stripInvisibleOutsideStrings', () => {
  it('only touches characters outside strings', () => {
    const r = stripInvisibleOutsideStrings('\u200B{"a\u200B":\u00A01,"b":"\\"\u00A0"}\u2060');
    expect(r.text).toBe('{"a\u200B": 1,"b":"\\"\u00A0"}');
    expect(r.removed).toBe(3);
  });
  it('is a no-op without invisible characters', () => {
    expect(stripInvisibleOutsideStrings('{"a":1}')).toEqual({ text: '{"a":1}', removed: 0 });
  });
});

describe('countLines', () => {
  it('counts', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(3);
  });
});
