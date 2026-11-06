import { LosslessNumber } from 'lossless-json';
import { budget } from '@shared/budget';
import {
  columnWarnings,
  computeColumns,
  countRows,
  DEFAULT_CSV_OPTIONS,
  escapeCell,
  formatPrimitive,
  generateCsv,
  getRecords,
  previewRows,
  protectInjection,
  toCsv,
} from './csv';

const lines = (csv: string) => csv.split('\n').filter((l, i, a) => i < a.length - 1 || l !== '');

describe('CSV — plan.md §8.3', () => {
  it('flat objects', () => {
    expect(
      toCsv([
        { a: 1, b: 'x' },
        { a: 2, b: 'y' },
      ]),
    ).toBe('a,b\n1,x\n2,y\n');
  });

  it('nested objects use dotted column names', () => {
    expect(toCsv([{ user: { address: { city: 'X' } }, id: 1 }])).toBe('user.address.city,id\nX,1\n');
  });

  it('other path separators', () => {
    expect(lines(toCsv([{ u: { c: 1 } }], { separator: '/' }))[0]).toBe('u/c');
    expect(lines(toCsv([{ u: { c: 1 } }], { separator: '_' }))[0]).toBe('u_c');
  });

  it('records with different shapes: union of columns in first-seen order, empty cells for missing', () => {
    expect(toCsv([{ a: 1 }, { b: 2, a: 3 }, { c: { d: 4 } }])).toBe('a,b,c.d\n1,,\n3,2,\n,,4\n');
  });

  describe('array modes', () => {
    const data = [
      {
        id: 1,
        tags: ['a', 'b', 'c'],
        items: [
          { sku: 'X', q: 1 },
          { sku: 'Y', q: 2 },
        ],
      },
    ];

    it('auto: join primitives, JSON for arrays of objects', () => {
      expect(toCsv(data)).toBe(
        'id,tags,items\n1,a; b; c,"[{""sku"":""X"",""q"":1},{""sku"":""Y"",""q"":2}]"\n',
      );
    });

    it('join with a custom separator (objects inside are JSON)', () => {
      expect(toCsv(data, { arrayMode: 'join', joinSeparator: '|' })).toBe(
        'id,tags,items\n1,a|b|c,"{""sku"":""X"",""q"":1}|{""sku"":""Y"",""q"":2}"\n',
      );
    });

    it('index: one column per element, capped', () => {
      expect(toCsv(data, { arrayMode: 'index' })).toBe(
        'id,tags.0,tags.1,tags.2,items.0.sku,items.0.q,items.1.sku,items.1.q\n1,a,b,c,X,1,Y,2\n',
      );
      expect(lines(toCsv(data, { arrayMode: 'index', indexCap: 1 }))[0]).toBe(
        'id,tags.0,items.0.sku,items.0.q',
      );
    });

    it('json: the whole array in one cell', () => {
      expect(toCsv([{ t: ['a', 1] }], { arrayMode: 'json' })).toBe('t\n"[""a"",1]"\n');
    });

    it('per-path override beats the global mode', () => {
      expect(toCsv(data, { arrayMode: 'json', arrayOverrides: { tags: 'index' } }).split('\n')[0]).toBe(
        'id,tags.0,tags.1,tags.2,items',
      );
    });

    it('explode: one row per element with parent fields repeated', () => {
      const csv = toCsv(
        [
          {
            id: 1,
            items: [
              { sku: 'X', q: 1 },
              { sku: 'Y', q: 2 },
            ],
          },
          { id: 2, items: [] },
          { id: 3 },
        ],
        { explodePath: ['items'] },
      );
      expect(csv).toBe('id,items.sku,items.q\n1,X,1\n1,Y,2\n2,,\n3,,\n');
    });

    it('explode a primitive array and a nested path', () => {
      expect(toCsv([{ id: 1, tags: ['a', 'b'] }], { explodePath: ['tags'] })).toBe('id,tags\n1,a\n1,b\n');
      expect(toCsv([{ o: { list: [1, 2] }, k: 'v' }], { explodePath: ['o', 'list'] })).toBe(
        'o.list,k\n1,v\n2,v\n',
      );
    });

    it('countRows estimates exploded rows', () => {
      const recs = [{ a: [1, 2, 3] }, { a: [] }, {}, 5];
      expect(countRows(recs, { ...DEFAULT_CSV_OPTIONS, explodePath: ['a'] })).toBe(6);
      expect(countRows(recs, DEFAULT_CSV_OPTIONS)).toBe(4);
    });

    it('empty arrays', () => {
      expect(toCsv([{ a: [] }])).toBe('a\n\n');
      expect(toCsv([{ a: [] }], { arrayMode: 'json' })).toBe('a\n[]\n');
    });
  });

  it('max depth writes deeper values as JSON', () => {
    expect(toCsv([{ a: { b: { c: 1 } } }], { maxDepth: 1 })).toBe('a\n"{""b"":{""c"":1}}"\n');
    expect(toCsv([{ a: { b: { c: 1 } } }], { maxDepth: 2 })).toBe('a.b\n"{""c"":1}"\n');
  });

  it('escapes the delimiter, quotes, CR and LF (RFC 4180)', () => {
    expect(toCsv([{ a: 'x,y', b: 'say "hi"', c: 'l1\nl2', d: 'cr\r', e: 'plain' }])).toBe(
      'a,b,c,d,e\n"x,y","say ""hi""","l1\nl2","cr\r",plain\n',
    );
    expect(escapeCell('a;b', ';', false)).toBe('"a;b"');
    expect(escapeCell('a;b', ',', false)).toBe('a;b');
    expect(escapeCell('a', ',', true)).toBe('"a"');
  });

  it('other delimiters and always-quote', () => {
    expect(toCsv([{ a: 1, b: 'x' }], { delimiter: '\t' })).toBe('a\tb\n1\tx\n');
    expect(toCsv([{ a: 1, b: 'x;y' }], { delimiter: ';' })).toBe('a;b\n1;"x;y"\n');
    expect(toCsv([{ a: 1, b: null }], { quoteAll: true })).toBe('"a","b"\n"1",""\n');
  });

  it('unicode and emoji pass through', () => {
    expect(toCsv([{ name: 'Zürich 🎉', jp: '東京' }])).toBe('name,jp\nZürich 🎉,東京\n');
  });

  it('UTF-8 BOM, CRLF, no header', () => {
    expect(toCsv([{ a: 1 }], { bom: true })).toBe('\uFEFFa\n1\n');
    expect(toCsv([{ a: 1 }], { bom: true, header: false })).toBe('\uFEFF1\n');
    expect(toCsv([{ a: 1 }, { a: 2 }], { eol: '\r\n' })).toBe('a\r\n1\r\n2\r\n');
    expect(toCsv([], { bom: true, header: false })).toBe('\uFEFF');
  });

  it('null and boolean options', () => {
    expect(toCsv([{ n: null, t: true, f: false }])).toBe('n,t,f\n,true,false\n');
    expect(toCsv([{ n: null, t: true, f: false }], { nullAs: 'null', boolCase: 'upper' })).toBe(
      'n,t,f\nnull,TRUE,FALSE\n',
    );
  });

  it('CSV injection protection (on by default, can be turned off)', () => {
    const rows = [{ a: '=SUM(A1)', b: '+1+2', c: '-5', d: '@cmd', e: '-1.5e3', f: 3, g: '-x' }];
    expect(toCsv(rows)).toBe("a,b,c,d,e,f,g\n'=SUM(A1),'+1+2,-5,'@cmd,-1.5e3,3,'-x\n");
    expect(toCsv(rows, { injectionProtection: false })).toBe(
      'a,b,c,d,e,f,g\n=SUM(A1),+1+2,-5,@cmd,-1.5e3,3,-x\n',
    );
    expect(protectInjection('\tx')).toBe("'\tx");
    expect(protectInjection('')).toBe('');
  });

  it('a single object at the root becomes one row', () => {
    expect(getRecords({ a: 1 })).toEqual([{ a: 1 }]);
    expect(toCsv({ a: 1, b: { c: 2 } })).toBe('a,b.c\n1,2\n');
  });

  it('an array of primitives becomes a one-column CSV with a "value" header', () => {
    expect(toCsv([1, 'two', null, true])).toBe('value\n1\ntwo\n\ntrue\n');
  });

  it('a primitive root', () => {
    expect(toCsv('hello')).toBe('value\nhello\n');
  });

  it('an empty array gives an empty CSV', () => {
    expect(toCsv([])).toBe('\n');
    expect(computeColumns([], DEFAULT_CSV_OPTIONS)).toEqual([]);
  });

  it('empty objects inside records', () => {
    expect(toCsv([{ a: {}, b: 1 }])).toBe('a,b\n{},1\n');
    expect(toCsv([{}])).toBe('\n\n');
  });

  it('big numbers are written as their exact text', () => {
    expect(toCsv([{ id: new LosslessNumber('12345678901234567890') }])).toBe('id\n12345678901234567890\n');
  });

  it('formatPrimitive edge cases', () => {
    expect(formatPrimitive(undefined, DEFAULT_CSV_OPTIONS)).toBe('');
    expect(formatPrimitive(NaN, DEFAULT_CSV_OPTIONS)).toBe('');
    expect(formatPrimitive(1.5, DEFAULT_CSV_OPTIONS)).toBe('1.5');
  });

  it('warns above 5,000 columns', () => {
    expect(columnWarnings(5001)[0]).toMatch(/5,001 columns/);
    expect(columnWarnings(10)).toEqual([]);
  });

  it('previewRows returns unescaped, injection-protected cells', () => {
    const recs = [{ a: 'x,y', b: '=1+1' }, { a: 'z' }];
    const cols = computeColumns(recs, DEFAULT_CSV_OPTIONS);
    expect(previewRows(recs, cols, DEFAULT_CSV_OPTIONS, 10)).toEqual([
      ['x,y', "'=1+1"],
      ['z', ''],
    ]);
    expect(previewRows(recs, cols, DEFAULT_CSV_OPTIONS, 1)).toHaveLength(1);
    expect(previewRows(recs, cols, { ...DEFAULT_CSV_OPTIONS, injectionProtection: false }, 10)[0][1]).toBe(
      '=1+1',
    );
  });

  it('100k rows finish inside the budget', () => {
    const recs = Array.from({ length: 100_000 }, (_, i) => ({
      id: i,
      name: `user ${i}`,
      address: { city: 'Colombo', zip: '10100' },
      tags: ['a', 'b'],
      active: i % 2 === 0,
      note: i % 10 === 0 ? 'has, comma' : null,
    }));
    const t = performance.now();
    const cols = computeColumns(recs, DEFAULT_CSV_OPTIONS);
    let rows = 0;
    let bytes = 0;
    for (const line of generateCsv(recs, cols, DEFAULT_CSV_OPTIONS)) {
      rows++;
      bytes += line.length;
    }
    const ms = performance.now() - t;
    expect(rows).toBe(100_001);
    expect(bytes).toBeGreaterThan(3_000_000);
    expect(ms).toBeLessThan(budget(3000));
  });
});
