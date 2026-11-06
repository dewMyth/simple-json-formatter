import { buildIndex } from './indexBuilder';
import { budget } from '@shared/budget';
import { buildMatcher, DEFAULT_SEARCH_OPTIONS, search, searchIter } from './search';

const doc = {
  name: 'Alice',
  nameplate: 'x',
  items: [
    { name: 'Bob', n: 42 },
    { title: 'Alice in Wonderland', ok: true, z: null },
  ],
};
const built = buildIndex(doc);
const input = { ...built.index, keyList: built.keyList, values: built.values };
const ids = (q: string, o = {}) => [...search(input, q, { ...DEFAULT_SEARCH_OPTIONS, ...o }).ids];

describe('search', () => {
  it('finds keys and values case-insensitively', () => {
    // name(1) nameplate(2) items[0].name(5)
    expect(ids('name')).toEqual([1, 2, 5]);
    expect(ids('alice')).toEqual([1, 8]);
  });
  it('keys only / values only', () => {
    expect(ids('alice', { keys: true, values: false })).toEqual([]);
    expect(ids('name', { keys: false, values: true })).toEqual([]);
    expect(ids('x', { keys: false })).toEqual([2]);
  });
  it('case sensitive', () => {
    expect(ids('alice', { caseSensitive: true })).toEqual([]);
    expect(ids('Alice', { caseSensitive: true })).toEqual([1, 8]);
  });
  it('whole word', () => {
    expect(ids('name', { wholeWord: true })).toEqual([1, 5]);
    expect(ids('alice', { wholeWord: true })).toEqual([1, 8]);
  });
  it('regex', () => {
    // ids: root0 name1 nameplate2 items3 [0]4 name5 n6 [1]7 title8 ok9 z10
    expect(ids('^b', { regex: true })).toEqual([5]);
    expect(ids('^\\d+$', { regex: true })).toEqual([6]);
    expect(() => ids('(', { regex: true })).toThrow();
  });
  it('matches numbers, booleans and null as text', () => {
    expect(ids('42')).toEqual([6]);
    expect(ids('true')).toEqual([9]);
    expect(ids('null')).toEqual([10]);
  });
  it('empty query or no targets returns nothing', () => {
    expect(ids('')).toEqual([]);
    expect(ids('a', { keys: false, values: false })).toEqual([]);
  });
  it('caps results', () => {
    const r = search(input, 'a', DEFAULT_SEARCH_OPTIONS, 2);
    expect(r.ids.length).toBe(2);
    expect(r.more).toBe(true);
  });
  it('yields between slices', () => {
    const it = searchIter(input, 'zzz', DEFAULT_SEARCH_OPTIONS, 100, 3);
    let yields = 0;
    while (!it.next().done) yields++;
    expect(yields).toBeGreaterThan(0);
  });
  it('buildMatcher escapes plain text in whole-word mode', () => {
    expect(buildMatcher('a.b', { ...DEFAULT_SEARCH_OPTIONS, wholeWord: true })('a.b c')).toBe(true);
    expect(buildMatcher('a.b', { ...DEFAULT_SEARCH_OPTIONS, wholeWord: true })('axb')).toBe(false);
  });
  it('searches medium-sized data quickly', () => {
    const big = Array.from({ length: 50_000 }, (_, i) => ({
      id: i,
      name: `user ${i}`,
      tags: ['a', 'b'],
      ok: i % 2 === 0,
    }));
    const b = buildIndex(big);
    const t = performance.now();
    const r = search(
      { ...b.index, keyList: b.keyList, values: b.values },
      'user 4999',
      DEFAULT_SEARCH_OPTIONS,
    );
    expect(performance.now() - t).toBeLessThan(budget(500));
    expect(r.ids.length).toBe(11);
  });
});
