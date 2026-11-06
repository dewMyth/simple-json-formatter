import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { budget } from '../src/shared/budget';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const fixture = (name: string): string => join(ROOT, 'fixtures', name);

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    api: any;
    __jsonlens: any;
    __long: number[];
  }
}

async function launch(args: string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
  // VS Code terminals export ELECTRON_RUN_AS_NODE, which turns Electron into plain Node.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE'),
  ) as Record<string, string>;
  const app = await electron.launch({
    args: [join(ROOT, 'out/main/index.js'), ...args],
    env: { ...env, JSONLENS_E2E: '1', JSONLENS_USER_DATA: mkdtempSync(join(tmpdir(), 'jsonlens-e2e-')) },
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!window.__jsonlens && !!window.__jsonlens.getState().settings);
  return { app, page };
}

/** Opens a file the way the Open dialog does, and resolves when it's loaded. Returns elapsed ms. */
async function openFixture(page: Page, path: string): Promise<number> {
  return page.evaluate(async (p) => {
    const f = await window.api.openPath(p);
    const t = performance.now();
    await window.__jsonlens.actions.openFile(f);
    return performance.now() - t;
  }, path);
}

async function startLongTaskObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__long.push(e.duration);
    }).observe({ type: 'longtask' });
  });
}

const longTasks = (page: Page): Promise<number[]> => page.evaluate(() => window.__long);
const state = (page: Page, expr: string): Promise<any> =>
  page.evaluate((e) => new Function('s', `return ${e}`)(window.__jsonlens.getState()), expr);

async function setClipboard(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), text);
}

async function stubSaveDialog(app: ElectronApplication, filePath: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as typeof dialog.showSaveDialog;
  }, filePath);
}

test.describe('JSONLens', () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    ({ app, page } = await launch());
  });
  test.afterEach(async () => {
    await app.close();
  });

  test('shows the empty state and toggles the theme', async () => {
    await expect(page.getByTestId('empty-text')).toBeVisible();
    const before = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.getByTestId('btn-theme').click();
    await expect
      .poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .not.toBe(before);
  });

  test('phase 1/2: medium.json loads inside budget with no main-thread task over 100 ms', async () => {
    test.skip(!existsSync(fixture('medium.json')), 'run npm run fixtures');
    await startLongTaskObserver(page);
    const ms = await openFixture(page, fixture('medium.json'));
    await page.waitForTimeout(500); // let layout/paint and the linter settle
    expect(ms).toBeLessThan(budget(1500));
    expect(await state(page, 's.doc.stats.lines')).toBeGreaterThan(90_000);
    const tasks = await longTasks(page);
    console.log(`medium.json: ${ms.toFixed(0)} ms; long tasks: ${JSON.stringify(tasks.map(Math.round))}`);
    expect(Math.max(0, ...tasks)).toBeLessThan(budget(100));
  });

  test('no main-thread task over 100 ms during any operation on medium.json', async () => {
    test.skip(!existsSync(fixture('medium.json')), 'run npm run fixtures');
    await startLongTaskObserver(page);
    await openFixture(page, fixture('medium.json'));
    const out = mkdtempSync(join(tmpdir(), 'jsonlens-out-'));
    await page.getByTestId('btn-expand-all').click();
    await page.getByTestId('tree').evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
    await page.waitForTimeout(100);
    await page.getByTestId('btn-collapse-all').click();
    await page.getByTestId('search-input').fill('Colombo');
    await expect(page.getByTestId('search-count')).toContainText(' of ');
    await page.getByTestId('search-input').press('Enter');
    await page.getByTestId('tab-text').click();
    await page.getByTestId('btn-format').click();
    await expect.poll(() => state(page, 's.job === null && s.tab === "viewer"')).toBe(true);
    await page.getByTestId('btn-export-csv').click();
    await expect(page.getByTestId('csv-totals')).toContainText('rows');
    await stubSaveDialog(app, join(out, 'm.csv'));
    await page.getByTestId('csv-export').click();
    await expect(page.getByTestId('toasts')).toContainText('Saved');
    await stubSaveDialog(app, join(out, 'm.json'));
    await page.evaluate(() => window.__jsonlens.actions.saveJson());
    await expect.poll(() => existsSync(join(out, 'm.json'))).toBe(true);
    await page.waitForTimeout(300);
    const tasks = await longTasks(page);
    console.log(`all operations: long tasks ${JSON.stringify(tasks.map(Math.round))}`);
    expect(Math.max(0, ...tasks)).toBeLessThan(budget(100));
  });

  test('phase 2: pasting each messy input gives valid pretty JSON', async () => {
    const raw = String.raw;
    const cases: Array<[string, unknown]> = [
      ['{"a":1}', { a: 1 }],
      [raw`"{\"a\":1}"`, { a: 1 }],
      [raw`"\"{\\\"a\\\":1}\""`, { a: 1 }],
      [raw`{\"a\":\"x\"}`, { a: 'x' }],
      [raw`{\n\t"a": "line1\nline2"}`, { a: 'line1\nline2' }],
      ['{"a":1,}', { a: 1 }],
      ["{'a': True, b: None}", { a: true, b: null }],
      ['callback({"a":1});', { a: 1 }],
      ['```json\n{"a":1}\n```', { a: 1 }],
      ['INFO 12:00 payload={"a":1}', { a: 1 }],
      ['{"a":1}\n{"a":2}', [{ a: 1 }, { a: 2 }]],
      [raw`{"msg":"tab\there"}`, { msg: 'tab\there' }],
    ];
    for (const [input, expected] of cases) {
      await setClipboard(app, input);
      await page.getByTestId('btn-paste').click();
      await expect.poll(() => state(page, 's.job === null && s.doc !== null')).toBe(true);
      const text: string = await state(page, 's.editorPush.text');
      expect(JSON.parse(text), input).toEqual(expected);
      expect(text).toBe(JSON.stringify(expected, null, 2));
    }
    // big numbers survive exactly
    await setClipboard(app, '{"id": 12345678901234567890}');
    await page.getByTestId('btn-paste').click();
    await expect.poll(() => state(page, 's.editorPush.text')).toContain('12345678901234567890');
  });

  test('phase 2: Cmd/Ctrl+V into an empty editor formats automatically', async () => {
    await setClipboard(app, '{"b":[1,2],"a":"x"}');
    await page.locator('.cm-content').click();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', '{"b":[1,2],"a":"x"}');
      document
        .querySelector('.cm-content')!
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect
      .poll(() => state(page, 's.editorPush.text'))
      .toBe('{\n  "b": [\n    1,\n    2\n  ],\n  "a": "x"\n}');
    await expect(page.getByTestId('tab-viewer')).toHaveAttribute('aria-selected', 'true');
  });

  test('phase 2: errors show a banner and jump to the error; the previous tree is kept', async () => {
    await page.evaluate(() => window.__jsonlens.actions.loadText('{"ok": true}'));
    await page.evaluate(() => window.__jsonlens.actions.loadText('{\n  "a": 1,\n  "b" 1 ::\n}'));
    const banner = page.getByTestId('error-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('line 3, column 7');
    await expect(banner).toContainText('previous tree is kept');
    expect(await state(page, 's.doc.stats.nodes')).toBe(2);
    await page.getByTestId('btn-jump-error').click();
    const line = await page.locator('.cm-activeLine').textContent();
    expect(line).toContain('"b" 1 ::');
  });

  test('phase 2/5: cancelling a load keeps the previous document working', async () => {
    test.skip(!existsSync(fixture('large.json')), 'run npm run fixtures');
    await openFixture(page, fixture('small.json'));
    const nodes = await state(page, 's.doc.stats.nodes');
    void page.evaluate(async (p) => {
      const f = await window.api.openPath(p);
      await window.__jsonlens.actions.openFile(f);
    }, fixture('large.json'));
    await expect(page.getByTestId('loader')).toBeVisible({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('loader')).toBeHidden();
    expect(await state(page, 's.doc.stats.nodes')).toBe(nodes);
    // the respawned worker was restored with the previous document
    const v = await page.evaluate(() => window.__jsonlens.actions.getValue(1, false));
    expect(v).toContain('gen-fixtures');
  });

  test('phase 3: large.json virtualises (<150 rows mounted) and toggles fast', async () => {
    test.skip(!existsSync(fixture('large.json')), 'run npm run fixtures');
    await openFixture(page, fixture('large.json'));
    expect(await state(page, 's.doc.largeDoc')).toBe(true); // 36 MB > 25 MB → tree view only
    await page.getByTestId('btn-expand-all').click();
    const rows = await state(page, 's.doc.visible.length');
    expect(rows).toBeGreaterThan(800_000);
    const tree = page.getByTestId('tree');
    for (const frac of [0.25, 0.5, 0.99]) {
      await tree.evaluate((el, f) => (el.scrollTop = el.scrollHeight * f), frac);
      await page.waitForTimeout(100);
      const mounted = await page.locator('[role=treeitem]').count();
      expect(mounted).toBeGreaterThan(10);
      expect(mounted).toBeLessThan(150);
    }
    // toggle one node: store update + render
    const ms = await page.evaluate(async () => {
      const id = 3;
      const t = performance.now();
      window.__jsonlens.actions.toggle(id);
      await new Promise(requestAnimationFrame);
      return performance.now() - t;
    });
    expect(ms).toBeLessThan(budget(50));
    const all = await page.evaluate(async () => {
      const t = performance.now();
      window.__jsonlens.actions.collapseAll();
      window.__jsonlens.actions.expandAll();
      await new Promise(requestAnimationFrame);
      return performance.now() - t;
    });
    expect(all).toBeLessThan(budget(300 * 2));
  });

  test('phase 3: depth-500 nesting works without a stack overflow', async () => {
    test.skip(!existsSync(fixture('deep.json')), 'run npm run fixtures');
    await openFixture(page, fixture('deep.json'));
    expect(await state(page, 's.doc.stats.maxDepth')).toBeGreaterThanOrEqual(500);
    await page.getByTestId('btn-expand-all').click();
    await page.getByTestId('tree').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(page.locator('[role=treeitem]', { hasText: 'bottom' })).toBeVisible();
  });

  test('phase 3: keyboard navigation', async () => {
    await page.evaluate(() => window.__jsonlens.actions.loadText('{"a":{"b":1},"c":[1,2]}'));
    const tree = page.getByTestId('tree');
    await tree.focus();
    await page.keyboard.press('ArrowDown'); // a
    expect(await state(page, 's.selected')).toBe(1);
    await page.keyboard.press('ArrowLeft'); // collapse a
    expect(await state(page, 's.doc.expanded[1]')).toBe(0);
    await page.keyboard.press('ArrowRight'); // expand a
    await page.keyboard.press('ArrowRight'); // to b
    expect(await state(page, 's.selected')).toBe(2);
    await page.keyboard.press('ArrowLeft'); // to parent a
    expect(await state(page, 's.selected')).toBe(1);
    await page.keyboard.press('End');
    expect(await state(page, 's.selected')).toBe(5);
    await page.keyboard.press('Home');
    expect(await state(page, 's.selected')).toBe(0);
  });

  test('phase 4: search medium.json < 500 ms and reveal a nested result', async () => {
    test.skip(!existsSync(fixture('medium.json')), 'run npm run fixtures');
    await openFixture(page, fixture('medium.json'));
    const ms = await page.evaluate(async () => {
      const st = window.__jsonlens.getState();
      const t = performance.now();
      await window.__jsonlens.actions.runSearch('SKU-3003', st.search.opts);
      return performance.now() - t;
    });
    expect(ms).toBeLessThan(budget(500));
    const count = await state(page, 's.search.ids.length');
    expect(count).toBeGreaterThan(10);
    await expect(page.getByTestId('search-count')).toContainText(`1 of ${count.toLocaleString('en-US')}`);
    // jump to a late result: its ancestors expand and it scrolls into view
    await page.evaluate(() =>
      window.__jsonlens.actions.goToResult(window.__jsonlens.getState().search.ids.length - 5),
    );
    const id = await state(page, 's.selected');
    await expect(page.locator(`#node-${id}`)).toBeVisible();
    await expect(page.getByTestId('node-path')).toContainText('.orders[');
    await expect(page.locator(`#node-${id} mark`)).toHaveText('SKU-3003');
  });

  test('phase 4: search via the search box, property panel and context menu copy', async () => {
    await page.evaluate(() =>
      window.__jsonlens.actions.loadText(
        JSON.stringify({ users: [{ name: 'Ann', long: 'x'.repeat(500) }, { name: 'Bob' }] }),
      ),
    );
    await page.getByTestId('search-input').fill('bob');
    await expect(page.getByTestId('search-count')).toHaveText('1 of 1');
    await expect(page.getByTestId('node-path')).toHaveText('$.users[1].name');
    // full value of a truncated string is fetched lazily
    await page.evaluate(() => window.__jsonlens.actions.select(4, { reveal: true }));
    await expect(page.getByTestId('full-value')).toHaveText('x'.repeat(500));
    // right-click → copy path
    await page.locator('#node-4').click({ button: 'right' });
    await expect(page.getByTestId('context-menu')).toBeVisible();
    await page.getByRole('menuitem', { name: 'Copy path' }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('$.users[0].long');
    await page.locator('#node-2').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Copy subtree as formatted JSON' }).click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('"long"');
  });

  test('phase 5: save formatted JSON streams to disk', async () => {
    await page.evaluate(() => window.__jsonlens.actions.loadText('{"b":1,"a":[true,null]}'));
    const out = join(mkdtempSync(join(tmpdir(), 'jsonlens-out-')), 'out.json');
    await stubSaveDialog(app, out);
    await page.evaluate(() => window.__jsonlens.actions.saveJson());
    await expect.poll(() => existsSync(out)).toBe(true);
    expect(readFileSync(out, 'utf8')).toBe('{\n  "b": 1,\n  "a": [\n    true,\n    null\n  ]\n}');
  });

  test('phase 6: CSV export through the dialog matches the golden file', async () => {
    await openFixture(page, join(ROOT, 'fixtures/samples/orders.json'));
    await page.getByTestId('btn-export-csv').click();
    const dialog = page.getByTestId('csv-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('csv-source')).toContainText('$.data.orders');
    await expect(page.getByTestId('csv-totals')).toContainText('3 rows × 9 columns');
    await expect(page.getByTestId('csv-preview')).toContainText('customer.address.city');
    // line endings default to the platform's; pick LF to compare with the golden file
    await dialog.locator('select').filter({ hasText: 'CRLF' }).selectOption({ label: 'LF' });
    const out = join(mkdtempSync(join(tmpdir(), 'jsonlens-out-')), 'orders.csv');
    await stubSaveDialog(app, out);
    await page.getByTestId('csv-export').click();
    await expect(page.getByTestId('toasts')).toContainText('Saved 3 rows × 9 columns');
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(join(ROOT, 'e2e/golden/orders.csv'), 'utf8'));
  });

  test('phase 6: 10k-row export takes < 3 s, with a BOM for Excel', async () => {
    test.skip(!existsSync(fixture('api-export.json')), 'run npm run fixtures');
    await openFixture(page, fixture('api-export.json'));
    const out = join(mkdtempSync(join(tmpdir(), 'jsonlens-out-')), 'api.csv');
    await stubSaveDialog(app, out);
    const ms = await page.evaluate(async () => {
      const opts = { ...window.__jsonlens.getState().settings.csv };
      const t = performance.now();
      await window.__jsonlens.actions.exportCsv({
        separator: '.',
        maxDepth: 0,
        arrayMode: 'auto',
        arrayOverrides: {},
        joinSeparator: '; ',
        indexCap: 50,
        explodePath: null,
        sourceNode: 0,
        delimiter: ',',
        quoteAll: false,
        header: true,
        bom: true,
        eol: '\r\n',
        nullAs: 'empty',
        boolCase: 'lower',
        injectionProtection: true,
        ...opts,
      });
      return performance.now() - t;
    });
    expect(ms).toBeLessThan(budget(3000));
    const bytes = readFileSync(out);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.toString('utf8').split('\r\n');
    expect(lines.length).toBe(10_002); // header + 10k rows + trailing empty
  });

  test('phase 6: explode creates one row per element', async () => {
    await openFixture(page, join(ROOT, 'fixtures/samples/orders.json'));
    await page.getByTestId('btn-export-csv').click();
    await expect(page.getByTestId('csv-totals')).toContainText('3 rows');
    await page.getByTestId('csv-explode').selectOption({ label: 'tags' });
    await expect(page.getByTestId('csv-totals')).toContainText('4 rows');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('csv-dialog')).toBeHidden();
  });
});

test.describe('huge documents', () => {
  test('phase 5: huge.json (200 MB) opens with the large-document banner', async () => {
    test.skip(!existsSync(fixture('huge.json')), 'run npm run fixtures -- --huge');
    test.setTimeout(180_000);
    const { app, page } = await launch([fixture('huge.json')]);
    try {
      await expect
        .poll(() => state(page, 's.doc?.stats.nodes ?? 0'), { timeout: 150_000 })
        .toBeGreaterThan(1_000_000);
      expect(await state(page, 's.doc.largeDoc')).toBe(true);
      await page.getByTestId('tab-text').click();
      await expect(page.getByTestId('large-banner')).toBeVisible();
      await page.getByTestId('tab-viewer').click();
      await expect(page.locator('[role=treeitem]').first()).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
