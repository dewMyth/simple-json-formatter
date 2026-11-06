import { existsSync, readFileSync } from 'node:fs';
import { budget } from '@shared/budget';
import { resolve } from 'node:path';
import type { ExportPortMsg, LoadOptions } from '@shared/types';
import { DEFAULT_CSV_OPTIONS } from './csv';
import { DEFAULT_SEARCH_OPTIONS } from './search';
import { Cancelled, LoadError, Session, utf8Length } from './session';

const OPTS: LoadOptions = {
  expandNested: false,
  bigNumbers: true,
  indent: 2,
  sortKeys: false,
  minify: false,
  editorMaxBytes: 25 * 1024 * 1024,
};
const noop = () => undefined;

function loaded(text: string, opts: Partial<LoadOptions> = {}) {
  const s = new Session();
  const r = s.load(text, utf8Length(text), { ...OPTS, ...opts }, noop);
  return { s, ...r };
}

/** A fake "main process" on the other end of an export port that collects chunks. */
function fakeMain() {
  const { port1, port2 } = new MessageChannel();
  const chunks: string[] = [];
  let aborted = false;
  port2.onmessage = (e: MessageEvent<ExportPortMsg>) => {
    const m = e.data;
    if (m.type === 'chunk') chunks.push(m.data);
    else if (m.type === 'abort') aborted = true;
    else if (m.type === 'end')
      port2.postMessage({ type: 'finished', bytes: Buffer.byteLength(chunks.join('')) });
  };
  return {
    port: port1 as unknown as MessagePort,
    text: () => chunks.join(''),
    aborted: () => aborted,
    close: () => port2.close(),
  };
}

describe('Session.load', () => {
  it('returns index, fixes, stats and formatted text', () => {
    const { payload, transfer } = loaded('{"a":[1,2],"b":"x"}');
    expect(payload.formatted).toBe('{\n  "a": [\n    1,\n    2\n  ],\n  "b": "x"\n}');
    expect(payload.stats).toMatchObject({ nodes: 5, maxDepth: 2, lines: 7 });
    expect(payload.fixes).toEqual([]);
    expect(transfer.length).toBe(12);
  });

  it('sorts keys and minifies', () => {
    const { payload } = loaded('{"b":1,"a":2}', { sortKeys: true, minify: true });
    expect(payload.formatted).toBe('{"a":2,"b":1}');
  });

  it('withholds formatted text above the editor threshold', () => {
    const text = JSON.stringify({ s: 'x'.repeat(2000) });
    const { payload } = loaded(text, { editorMaxBytes: 1000 });
    expect(payload.formatted).toBeUndefined();
    expect(payload.formattedBytes).toBeGreaterThan(1000);
  });

  it('throws LoadError with the source text on failure', () => {
    expect(() => loaded('{"a" 1 ::}')).toThrow(LoadError);
    try {
      loaded('{"a" 1 ::}');
    } catch (e) {
      expect((e as LoadError).sourceText).toBe('{"a" 1 ::}');
      expect((e as LoadError).error.line).toBe(1);
    }
  });

  it('keeps big numbers through format and getValue', () => {
    const { s, payload } = loaded('{"id": 12345678901234567890}');
    expect(payload.formatted).toContain('12345678901234567890');
    expect(payload.usedLossless).toBe(true);
    expect(s.getValue(1, true)).toBe('12345678901234567890');
    expect(s.format(2, false, true)).toBe('{"id":12345678901234567890}');
  });
});

describe('Session queries', () => {
  const { s } = loaded(
    JSON.stringify({
      meta: { v: 1 },
      data: {
        orders: [
          { id: 1, tags: ['a'] },
          { id: 2, tags: [] },
        ],
        misc: [1, 2],
      },
    }),
  );

  it('getValue returns text or JSON', () => {
    expect(s.getValue(0, false)).toContain('"orders"');
    expect(s.getValue(2, true)).toBe('1');
    expect(() => s.getValue(999, true)).toThrow();
  });

  it('format with sort keys does not change the document', () => {
    expect(s.format(2, true, true).startsWith('{"data"')).toBe(true);
    expect(s.format(2, false, true).startsWith('{"meta"')).toBe(true);
  });

  it('pathOf builds JSONPath', () => {
    expect(s.pathOf(0)).toBe('$');
    expect(s.pathOf(6)).toBe('$.data.orders[0].id');
  });

  it('csvCandidates lists arrays of objects, largest first, plus the node itself', () => {
    const c = s.csvCandidates(0);
    expect(c[0]).toMatchObject({ path: '$.data.orders', length: 2, kind: 'objects' });
    expect(c.find((x) => x.nodeId === 0)?.kind).toBe('object');
    expect(c.some((x) => x.path === '$.data.misc')).toBe(false);
  });

  it('search is cancellable', async () => {
    const token = { cancelled: false };
    const r = await s.search('id', DEFAULT_SEARCH_OPTIONS, token);
    expect(r.ids.length).toBe(2);
  });

  it('lint reports errors', () => {
    expect(s.lint('{"a":1}')).toBeNull();
    expect(s.lint('{"a":}')).toMatchObject({ line: 1, column: 6 });
  });

  it('csvPreview', async () => {
    const ordersId = s.csvCandidates(0)[0].nodeId;
    const p = await s.csvPreview({ ...DEFAULT_CSV_OPTIONS, sourceNode: ordersId }, 100, { cancelled: false });
    expect(p.columns).toEqual(['id', 'tags']);
    expect(p.rows).toEqual([
      ['1', 'a'],
      ['2', ''],
    ]);
    expect(p.totalRows).toBe(2);
    expect(p.explodeCandidates.map((e) => e.label)).toEqual(['tags']);
    const ex = await s.csvPreview(
      { ...DEFAULT_CSV_OPTIONS, sourceNode: ordersId, explodePath: ['tags'] },
      100,
      { cancelled: false },
    );
    expect(ex.totalRows).toBe(2);
  });

  it('csvExport streams through the port and waits for main', async () => {
    const ordersId = s.csvCandidates(0)[0].nodeId;
    const main = fakeMain();
    const stages: string[] = [];
    const r = await s.csvExport(
      { ...DEFAULT_CSV_OPTIONS, sourceNode: ordersId },
      main.port,
      (st) => stages.push(st),
      { cancelled: false },
    );
    expect(r).toMatchObject({ rows: 2, columns: 2 });
    expect(main.text()).toBe('id,tags\n1,a\n2,\n');
    expect(stages.at(-1)).toMatch(/Writing CSV \(2 \/ 2 rows\)/);
    main.close();
  });

  it('saveJson streams formatted JSON', async () => {
    const main = fakeMain();
    const r = await s.saveJson(2, true, main.port, noop, { cancelled: false });
    expect(main.text()).toBe(s.format(2, false, true));
    expect(r.bytes).toBe(main.text().length);
    main.close();
  });

  it('requires a document', () => {
    expect(() => new Session().getValue(0, true)).toThrow(/No document/);
  });
});

describe('cancellation', () => {
  it('a cancelled export aborts the port and throws Cancelled', async () => {
    const rows = Array.from({ length: 200_000 }, (_, i) => ({ i, s: 'text '.repeat(5) }));
    const { s } = loaded(JSON.stringify(rows), { editorMaxBytes: 0 });
    const main = fakeMain();
    const token = { cancelled: false };
    const p = s.csvExport({ ...DEFAULT_CSV_OPTIONS, sourceNode: 0 }, main.port, noop, token);
    setTimeout(() => (token.cancelled = true), 20);
    await expect(p).rejects.toBeInstanceOf(Cancelled);
    await new Promise((r) => setTimeout(r, 10));
    expect(main.aborted()).toBe(true);
    main.close();
  });
});

const medium = resolve(__dirname, '../../fixtures/medium.json');
describe.skipIf(!existsSync(medium))('medium.json budget', () => {
  it('sanitise + parse + format + index in < 1.5 s', () => {
    const text = readFileSync(medium, 'utf8');
    const t = performance.now();
    const { payload } = loaded(text);
    const ms = performance.now() - t;
    expect(payload.stats.lines).toBeGreaterThan(90_000);
    expect(ms).toBeLessThan(budget(1500));
    console.log(`medium.json: ${payload.stats.nodes} nodes, ${ms.toFixed(0)} ms`);
  });

  it('double-stringified medium.json unwraps', () => {
    const text = readFileSync(medium.replace('.json', '.double.json'), 'utf8');
    const { payload } = loaded(text);
    expect(payload.fixes.some((f) => /Unwrapped/.test(f))).toBe(true);
  });
});
