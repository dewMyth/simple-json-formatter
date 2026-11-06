import { buildIndex } from '@worker/indexBuilder';
import { budget } from '@shared/budget';
import {
  childrenOf,
  computeVisible,
  containerSummary,
  defaultExpanded,
  displayValue,
  expandAncestors,
  expandToLevel,
  formatBytes,
  getKey,
  getLabel,
  pathOf,
  rowOf,
  setAll,
  setSubtree,
} from './visible';

// root0 { a1:{ b2:[ 3:1, 4:{ c5:"x" } ] }, "odd key"6: true, s7: "long…" }
const doc = { a: { b: [1, { c: 'x' }] }, 'odd key': true, s: 'q'.repeat(300) };
const { index: idx } = buildIndex(doc);

describe('visible rows', () => {
  it('default view expands the root and its first level', () => {
    const e = defaultExpanded(idx);
    expect([...computeVisible(idx, e)]).toEqual([0, 1, 2, 6, 7]);
  });

  it('collapse all shows only the root; expand all shows everything', () => {
    const e = new Uint8Array(idx.n);
    expect([...computeVisible(idx, setAll(idx, e, 0))]).toEqual([0]);
    expect([...computeVisible(idx, setAll(idx, e, 1))]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('expand to level', () => {
    const e = expandToLevel(idx, new Uint8Array(idx.n), 1);
    expect([...computeVisible(idx, e)]).toEqual([0, 1, 6, 7]);
  });

  it('subtree expand/collapse', () => {
    const e = setAll(idx, new Uint8Array(idx.n), 0);
    e[0] = 1;
    setSubtree(idx, e, 1, 1);
    expect([...computeVisible(idx, e)]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    setSubtree(idx, e, 1, 0);
    expect([...computeVisible(idx, e)]).toEqual([0, 1, 6, 7]);
  });

  it('expandAncestors reveals a deep node', () => {
    const e = new Uint8Array(idx.n);
    expect(expandAncestors(idx, e, 5)).toBe(true);
    expect(rowOf(computeVisible(idx, e), 5)).toBeGreaterThan(0);
    expect(expandAncestors(idx, e, 5)).toBe(false);
  });

  it('rowOf', () => {
    const v = Int32Array.from([0, 3, 9, 12]);
    expect(rowOf(v, 9)).toBe(2);
    expect(rowOf(v, 4)).toBe(-1);
  });

  it('is fast for 1M nodes', () => {
    const big = buildIndex(Array.from({ length: 250_000 }, (_, i) => ({ i, s: 'x', t: [i] }))).index;
    const e = setAll(big, new Uint8Array(big.n), 1);
    const t = performance.now();
    const v = computeVisible(big, e);
    expect(v.length).toBe(big.n);
    expect(performance.now() - t).toBeLessThan(budget(50));
  });
});

describe('labels and values', () => {
  it('keys, labels and paths', () => {
    expect(getKey(idx, 1)).toBe('a');
    expect(getKey(idx, 3)).toBeNull();
    expect(getLabel(idx, 0)).toBe('root');
    expect(getLabel(idx, 4)).toBe('1');
    expect(pathOf(idx, 5)).toBe('$.a.b[1].c');
    expect(pathOf(idx, 6)).toBe("$['odd key']");
  });

  it('display values', () => {
    expect(containerSummary(idx, 2)).toBe('[2]');
    expect(displayValue(idx, 1)).toBe('{1}');
    expect(displayValue(idx, 5)).toBe('"x"');
    expect(displayValue(idx, 6)).toBe('true');
    expect(displayValue(idx, 7).endsWith('…"')).toBe(true);
  });

  it('childrenOf jumps over subtrees', () => {
    expect([...childrenOf(idx, 0)]).toEqual([1, 6, 7]);
    expect([...childrenOf(idx, 2)]).toEqual([3, 4]);
    expect([...childrenOf(idx, 3)]).toEqual([]);
  });

  it('formatBytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(4.1 * 1024 * 1024)).toBe('4.1 MB');
  });
});
