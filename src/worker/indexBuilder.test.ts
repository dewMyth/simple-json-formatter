import { LosslessNumber } from 'lossless-json';
import { NodeFlag, NodeType } from '@shared/types';
import { buildIndex, packStrings, tableString } from './indexBuilder';

describe('buildIndex', () => {
  const doc = {
    a: 1,
    b: [true, null, 'x'],
    c: {},
    d: { e: [] },
    big: new LosslessNumber('12345678901234567890'),
  };
  const { index: idx, keyList, values } = buildIndex(doc);

  it('builds a pre-order index', () => {
    // root, a, b, b0, b1, b2, c, d, e, big
    expect(idx.n).toBe(10);
    expect([...idx.type]).toEqual([0, 3, 1, 4, 5, 2, 0, 0, 1, 6]);
    expect([...idx.depth]).toEqual([0, 1, 1, 2, 2, 2, 1, 1, 2, 1]);
    expect([...idx.parent]).toEqual([-1, 0, 0, 2, 2, 2, 0, 0, 7, 0]);
    expect([...idx.subtreeEnd]).toEqual([10, 2, 6, 4, 5, 6, 7, 9, 9, 10]);
    expect([...idx.childCount]).toEqual([5, 0, 3, 0, 0, 0, 0, 1, 0, 0]);
    expect([...idx.arrayIndex]).toEqual([-1, -1, -1, 0, 1, 2, -1, -1, -1, -1]);
    expect(idx.maxDepth).toBe(2);
  });

  it('interns keys', () => {
    expect(keyList).toEqual(['a', 'b', 'c', 'd', 'e', 'big']);
    expect([...idx.keyId]).toEqual([-1, 0, 1, -1, -1, -1, 2, 3, 4, 5]);
    expect(tableString(idx.keys, 5)).toBe('big');
  });

  it('stores previews for primitives', () => {
    const p = (i: number) => tableString(idx.preview, i);
    expect([p(0), p(1), p(3), p(4), p(5), p(9)]).toEqual([
      '',
      '1',
      'true',
      'null',
      'x',
      '12345678901234567890',
    ]);
  });

  it('keeps a value per node', () => {
    expect(values[2]).toBe(doc.b);
    expect(values[5]).toBe('x');
  });

  it('truncates long string previews and flags them', () => {
    const { index } = buildIndex({ s: 'y'.repeat(500), t: 'a'.repeat(199) + '😀' + 'b' });
    expect(tableString(index.preview, 1).length).toBe(200);
    expect(index.flags[1] & NodeFlag.Truncated).toBe(1);
    // does not split the surrogate pair at the boundary
    expect(tableString(index.preview, 2)).toBe('a'.repeat(199));
  });

  it('handles depth 5,000 without a stack overflow', () => {
    let v: unknown = { leaf: 1 };
    for (let i = 0; i < 5000; i++) v = i % 2 ? [v] : { k: v };
    const { index } = buildIndex(v);
    expect(index.n).toBe(5002);
    expect(index.maxDepth).toBe(5001);
    expect(index.subtreeEnd[0]).toBe(5002);
  });

  it('handles primitives at the root', () => {
    const { index } = buildIndex('hello');
    expect(index.n).toBe(1);
    expect(index.type[0]).toBe(NodeType.String);
    expect(index.subtreeEnd[0]).toBe(1);
  });

  it('reports progress on big inputs and grows past its initial capacity', () => {
    const big = Array.from({ length: 60_000 }, (_, i) => ({ i }));
    const pcts: number[] = [];
    const { index } = buildIndex(big, (p) => pcts.push(p));
    expect(index.n).toBe(120_001);
    expect(pcts.length).toBeGreaterThan(0);
    expect(pcts.every((p) => p >= 0 && p <= 99)).toBe(true);
  });
});

describe('string tables', () => {
  it('round-trips, including long strings and unicode', () => {
    const list = ['', 'a', 'héllo 😀', 'x'.repeat(10_000)];
    const t = packStrings(list);
    expect(list.map((_, i) => tableString(t, i))).toEqual(list);
  });
});
