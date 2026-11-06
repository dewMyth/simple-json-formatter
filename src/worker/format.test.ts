import { LosslessNumber } from 'lossless-json';
import { formatJson, indentString, serialize, sortKeysDeep, valueToText } from './format';

const sample = { b: [1, { z: true, a: null }, [], {}], a: 'x"\n', c: { y: -0, x: 1.5e300 }, e: '' };

describe('serialize', () => {
  it.each([['  '], ['    '], ['\t'], ['']])('matches JSON.stringify with indent %j', (ind) => {
    expect([...serialize(sample, ind)].join('')).toBe(JSON.stringify(sample, null, ind || undefined));
  });

  it('matches for primitives and empty containers at the root', () => {
    for (const v of [1, 'a', null, true, [], {}])
      expect([...serialize(v, '  ')].join('')).toBe(JSON.stringify(v, null, 2));
  });

  it('writes big numbers exactly', () => {
    const v = { id: new LosslessNumber('12345678901234567890'), list: [new LosslessNumber('1e400')] };
    expect([...serialize(v, '')].join('')).toBe('{"id":12345678901234567890,"list":[1e400]}');
  });

  it('streams in chunks', () => {
    const big = Array.from({ length: 5000 }, (_, i) => ({ i, s: 'abcdefghij' }));
    const chunks = [...serialize(big, '  ', 10_000)];
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.join('')).toBe(JSON.stringify(big, null, 2));
  });

  it('handles depth 10,000 without recursion', () => {
    let v: unknown = 1;
    for (let i = 0; i < 10_000; i++) v = [v];
    const s = [...serialize(v, '')].join('');
    expect(s.length).toBe(20_001);
  });

  it('writes NaN as null like JSON.stringify', () => {
    expect([...serialize([NaN, Infinity], '')].join('')).toBe('[null,null]');
  });
});

describe('formatJson', () => {
  it('uses JSON.stringify unless lossless', () => {
    expect(formatJson({ a: 1 }, 2, false, false)).toBe('{\n  "a": 1\n}');
    expect(formatJson({ a: 1 }, 4, true, false)).toBe('{"a":1}');
    expect(formatJson({ a: new LosslessNumber('99999999999999999999') }, '\t', false, true)).toBe(
      '{\n\t"a": 99999999999999999999\n}',
    );
  });
});

describe('sortKeysDeep', () => {
  it('sorts recursively and keeps arrays in order', () => {
    const s = sortKeysDeep(sample) as Record<string, unknown>;
    expect(Object.keys(s)).toEqual(['a', 'b', 'c', 'e']);
    expect(Object.keys((s.b as unknown[])[1] as object)).toEqual(['a', 'z']);
    expect(Object.keys(s.c as object)).toEqual(['x', 'y']);
    expect(sample.b[0]).toBe(1);
    expect(Object.keys(sample)).toEqual(['b', 'a', 'c', 'e']); // original untouched
  });
  it('returns primitives as-is', () => {
    expect(sortKeysDeep(5)).toBe(5);
  });
});

describe('helpers', () => {
  it('indentString', () => {
    expect(indentString(2, false)).toBe('  ');
    expect(indentString('\t', false)).toBe('\t');
    expect(indentString(4, true)).toBe('');
  });
  it('valueToText', () => {
    expect(valueToText('a"b', 2)).toBe('a"b');
    expect(valueToText(3, 2)).toBe('3');
    expect(valueToText(null, 2)).toBe('null');
    expect(valueToText({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
    expect(valueToText(new LosslessNumber('123456789012345678901'), 2)).toBe('123456789012345678901');
  });
});
