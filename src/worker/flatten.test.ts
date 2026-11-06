import { LosslessNumber } from 'lossless-json';
import {
  DEFAULT_FLATTEN_OPTIONS,
  explodeRecord,
  explodedRowCount,
  findArrays,
  flattenRecord,
  isPrimitive,
} from './flatten';

const ctx = (o = {}) => ({
  opts: { ...DEFAULT_FLATTEN_OPTIONS, ...o },
  fmt: (v: unknown) => (v === null ? '' : String(v)),
});
const flat = (v: unknown, o = {}) => Object.fromEntries(flattenRecord(v, ctx(o)));

describe('flattenRecord', () => {
  it('flattens nested objects in key order', () => {
    expect(flat({ a: 1, b: { c: 2, d: { e: 3 } } })).toEqual({ a: '1', 'b.c': '2', 'b.d.e': '3' });
  });
  it('primitives at the root use the value column', () => {
    expect(flat(5)).toEqual({ value: '5' });
    expect(flat([1, 2])).toEqual({ value: '1; 2' });
  });
  it('index mode on nested arrays inside arrays', () => {
    expect(flat({ m: [[1, 2], [3]] }, { arrayMode: 'index' })).toEqual({
      'm.0.0': '1',
      'm.0.1': '2',
      'm.1.0': '3',
    });
  });
  it('overrides use the generic path without index segments', () => {
    const v = { items: [{ tags: ['a', 'b'] }] };
    expect(flat(v, { arrayMode: 'index', arrayOverrides: { 'items.tags': 'json' } })).toEqual({
      'items.0.tags': '["a","b"]',
    });
  });
  it('very deep records fall back to JSON instead of recursing forever', () => {
    let v: unknown = 1;
    for (let i = 0; i < 1500; i++) v = { k: v };
    const out = flattenRecord(v, ctx());
    expect(out.size).toBe(1);
    expect([...out.values()][0].startsWith('{')).toBe(true);
  });
  it('isPrimitive', () => {
    expect(isPrimitive(new LosslessNumber('1'))).toBe(true);
    expect(isPrimitive({})).toBe(false);
    expect(isPrimitive(null)).toBe(true);
  });
});

describe('explode', () => {
  it('explodes and copies along the path without mutating the source', () => {
    const rec = { id: 1, o: { list: [1, 2], keep: true } };
    const rows = explodeRecord(rec, ['o', 'list']);
    expect(rows).toEqual([
      { id: 1, o: { list: 1, keep: true } },
      { id: 1, o: { list: 2, keep: true } },
    ]);
    expect(rec.o.list).toEqual([1, 2]);
  });
  it('missing, non-array, empty and primitive records', () => {
    expect(explodeRecord({ id: 1 }, ['x'])).toEqual([{ id: 1 }]);
    expect(explodeRecord({ x: 5 }, ['x'])).toEqual([{ x: 5 }]);
    expect(explodeRecord({ x: [], y: 1 }, ['x'])).toEqual([{ y: 1 }]);
    expect(explodeRecord(7, ['x'])).toEqual([7]);
    expect(explodeRecord({ a: 1 }, ['a', 'b'])).toEqual([{ a: 1 }]);
    expect(explodedRowCount({ x: [1, 2] }, ['x'])).toBe(2);
    expect(explodedRowCount({ x: 'no' }, ['x'])).toBe(1);
  });
});

describe('findArrays', () => {
  it('lists explode candidates (through objects only) and generic array paths', () => {
    const recs = [{ tags: ['a'], o: { list: [{ inner: [1] }] } }, { other: [] }];
    const r = findArrays(recs, '.');
    expect(r.explode.map((e) => e.label).sort()).toEqual(['o.list', 'other', 'tags']);
    expect(r.arrayPaths).toEqual(['o.list', 'o.list.inner', 'other', 'tags']);
    expect(findArrays(recs, '/').explode.find((e) => e.segments.length === 2)?.label).toBe('o/list');
  });
});
