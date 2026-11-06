import { locateJsonError } from './jsonError';

const at = (s: string) => locateJsonError(s);

describe('locateJsonError', () => {
  it.each([
    '{"a":1}',
    '[]',
    '{}',
    ' [1, -2.5e+3, 0, "x\\n\\u00e9", true, false, null, {"k": [ ]}] ',
    '"str"',
    '0',
  ])('accepts valid JSON %j', (s) => {
    expect(at(s)).toBeNull();
    expect(() => JSON.parse(s)).not.toThrow();
  });

  it.each([
    ['{"a":}', 5, /expected a value/],
    ['{"a":1,}', 7, /Trailing comma/],
    ['[1,]', 3, /Trailing comma/],
    ['{a:1}', 1, /double-quoted property name/],
    ['{"a" 1}', 5, /Expected ':'/],
    ['{"a":1 "b":2}', 7, /Expected ',' or '}'/],
    ['[1 2]', 3, /Expected ',' or ']'/],
    ['{"a":1', 6, /end of input/],
    ['[1', 2, /end of input/],
    ['"abc', 4, /Unterminated/],
    ['"a\\qb"', 2, /Bad escape/],
    ['"a\\u12"', 2, /Unicode/],
    ['"a\nb"', 2, /control character/],
    ['01', 1, /after the end/],
    ['-', 0, /Invalid number/],
    ['1.', 2, /decimal point/],
    ['1e', 2, /exponent/],
    ['tru', 0, /expected a value/],
    ['{"a":1}}', 7, /after the end/],
    ['', 0, /end of input/],
    ['{', 1, /property name/],
  ])('%j → offset %d', (s, offset, re) => {
    const r = at(s)!;
    expect(r).not.toBeNull();
    expect(r.offset).toBe(offset);
    expect(r.message).toMatch(re);
    expect(() => JSON.parse(s)).toThrow();
  });

  it('handles depth 100k without recursion', () => {
    expect(at('['.repeat(100_000) + ']'.repeat(100_000))).toBeNull();
    expect(at('['.repeat(100_000))!.offset).toBe(100_000);
  });
});
