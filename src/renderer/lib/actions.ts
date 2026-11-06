import type {
  CsvCandidate,
  CsvExportResult,
  CsvOptions,
  CsvPreview,
  LoadOptions,
  LoadedPayload,
  OpenedFile,
  SearchOptions,
  SearchResult,
  Settings,
  ThemePref,
} from '@shared/types';
import { LOADER_DELAY_MS } from '@shared/constants';
import {
  docFromPayload,
  getState,
  initialSearch,
  refreshVisible,
  setState,
  toast,
  type JobState,
  type Source,
} from '../store/useAppStore';
import { CancelledError, WorkerClient, WorkerError, type Job, type ReqBody } from './workerClient';
import { editor } from './editorBridge';
import { getExportPort } from './exportPort';
import {
  defaultExpanded,
  expandAncestors,
  expandToLevel,
  formatBytes,
  fmtInt,
  getKey,
  getLabel,
  isContainer,
  pathOf,
  setAll,
  setSubtree,
} from './visible';

export const client = new WorkerClient();

/** What the worker currently holds, so it can be reloaded if the worker has to be restarted. */
let lastGood: { source: Source; opts: LoadOptions } | null = null;

client.onRespawn = () => {
  // A cancel terminated the worker, and the parsed document went with it. The UI still shows the
  // previous good tree, so quietly load the same source into the new worker to keep them in sync.
  if (!lastGood) return;
  const { source, opts } = lastGood;
  void startRequest(source, { ...opts, editorMaxBytes: 0 })
    .then((job) => job.promise)
    .catch((e) => {
      if (!(e instanceof CancelledError)) toast('Could not restore the previous document', { kind: 'error' });
    });
};

// ───────────────────────── jobs and the loader ─────────────────────────

function progressHandler(): {
  onProgress: (stage: string, pct?: number) => void;
  bind: (id: number) => void;
} {
  let id = -1;
  let pending: { stage: string; pct?: number } | null = null;
  let scheduled = false;
  return {
    bind: (jobId) => (id = jobId),
    onProgress: (stage, pct) => {
      pending = { stage, pct };
      if (scheduled) return;
      scheduled = true;
      // Coalesce progress events to one store update per frame.
      requestAnimationFrame(() => {
        scheduled = false;
        const j = getState().job;
        if (j && j.id === id && pending) setState({ job: { ...j, stage: pending.stage, pct: pending.pct } });
      });
    },
  };
}

/** Tracks a job in the store; the loader overlay appears if it runs longer than LOADER_DELAY_MS. */
async function track<T>(job: Job<T>, stage: string, onCancel?: () => void): Promise<T> {
  const state: JobState = {
    id: job.id,
    stage,
    startedAt: performance.now(),
    shown: false,
    cancel: () => {
      onCancel?.();
      client.cancel(job.id);
    },
  };
  setState({ job: state });
  const timer = setTimeout(() => {
    const j = getState().job;
    if (j?.id === job.id) setState({ job: { ...j, shown: true } });
  }, LOADER_DELAY_MS);
  try {
    return await job.promise;
  } finally {
    clearTimeout(timer);
    if (getState().job?.id === job.id) setState({ job: null });
  }
}

/** Starts a worker request and tracks it with the loader. */
function run<T>(
  body: ReqBody,
  stage: string,
  opts: { transfer?: Transferable[]; onCancel?: () => void } = {},
): Promise<T> {
  const p = progressHandler();
  const job = client.request<T>(body, { onProgress: p.onProgress, transfer: opts.transfer });
  p.bind(job.id);
  return track(job, stage, opts.onCancel);
}

export function cancelJob(): void {
  getState().job?.cancel();
}

// ───────────────────────── settings & theme ─────────────────────────

export function settings(): Settings {
  const s = getState().settings;
  if (!s) throw new Error('Settings not loaded');
  return s;
}

export function updateSettings(patch: Partial<Settings>): void {
  const s = getState().settings;
  if (!s) return;
  setState({ settings: { ...s, ...patch } });
  void window.api.setSettings(patch);
  if (patch.theme) applyTheme(patch.theme);
}

export function resolvedTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
  window.api.setNativeTheme(pref);
}

export function toggleTheme(): void {
  updateSettings({ theme: resolvedTheme(settings().theme) === 'dark' ? 'light' : 'dark' });
}

export function setTab(tab: 'text' | 'viewer'): void {
  setState({ tab });
  updateSettings({ lastTab: tab });
}

// ───────────────────────── loading ─────────────────────────

function loadOptions(override: Partial<LoadOptions> = {}): LoadOptions {
  const s = settings();
  return {
    expandNested: s.expandNested,
    bigNumbers: s.bigNumbers,
    indent: s.indent,
    sortKeys: s.sortKeys,
    minify: false,
    editorMaxBytes: Math.max(1, s.editorMaxMB) * 1024 * 1024,
    ...override,
  };
}

/** Creates the worker request for a source (falls back to reading through main if fetch fails). */
async function startRequest(
  source: Source,
  opts: LoadOptions,
  progress?: ReturnType<typeof progressHandler>,
  viaIpc = false,
): Promise<Job<LoadedPayload>> {
  const req = (body: ReqBody, transfer?: Transferable[]): Job<LoadedPayload> => {
    const job = client.request<LoadedPayload>(body, { onProgress: progress?.onProgress, transfer });
    progress?.bind(job.id);
    return job;
  };
  switch (source.kind) {
    case 'text':
      return req({ kind: 'loadText', text: source.text, opts });
    case 'file':
      return req({ kind: 'loadFile', file: source.file, opts });
    case 'url':
      if (viaIpc) {
        const buffer = await window.api.readFile(source.path);
        return req({ kind: 'load', buffer, opts }, [buffer]);
      }
      return req({ kind: 'loadUrl', url: source.url, opts });
  }
}

const sourceName = (s: Source): string | null => (s.kind === 'text' ? null : s.name);
const sourcePath = (s: Source): string | null => (s.kind === 'text' ? null : (s.path ?? null));

function pushEditor(text: string): void {
  setState((s) => ({ editorPush: { text, seq: s.editorPush.seq + 1 } }));
}

/** Loads a source: sanitise → parse → index → format, then shows it. Returns true on success. */
export async function load(
  source: Source,
  override: Partial<LoadOptions> = {},
  viaIpc = false,
): Promise<boolean> {
  const running = getState().job;
  if (running) running.cancel();
  const opts = loadOptions(override);
  const progress = progressHandler();
  let job: Job<LoadedPayload>;
  try {
    job = await startRequest(source, opts, progress, viaIpc);
  } catch (e) {
    toast(`Could not open file: ${(e as Error).message}`, { kind: 'error' });
    return false;
  }
  const stage = source.kind === 'text' ? 'Cleaning up escapes…' : 'Reading file…';
  try {
    const payload = await track(job, stage);
    applyLoaded(payload, source, opts);
    return true;
  } catch (e) {
    if (e instanceof CancelledError) {
      toast('Cancelled');
      return false;
    }
    if (e instanceof WorkerError) {
      // fetch from the worker failed: read through main instead
      if (source.kind === 'url' && !viaIpc && e.detail.line === 0) return load(source, override, true);
      const text = source.kind === 'text' ? source.text : e.sourceText;
      setState({ error: e.detail.line > 0 ? e.detail : { ...e.detail, line: 1, column: 1 }, tab: 'text' });
      if (text !== undefined) pushEditor(text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'));
      return false;
    }
    toast(String((e as Error).message ?? e), { kind: 'error' });
    return false;
  }
}

function applyLoaded(p: LoadedPayload, source: Source, opts: LoadOptions): void {
  lastGood = { source, opts };
  const doc = docFromPayload(p, defaultExpanded(p.index), {
    name: sourceName(source),
    path: sourcePath(source),
  });
  const { search } = getState();
  setState({
    doc,
    selected: 0,
    scrollTo: { id: 0, seq: Date.now() },
    error: null,
    tab: 'viewer',
    search: { ...initialSearch, query: search.query, opts: search.opts },
    contextMenu: null,
  });
  pushEditor(p.formatted ?? '');
  if (search.query) void runSearch(search.query, search.opts);
}

export function loadText(text: string, override?: Partial<LoadOptions>): Promise<boolean> {
  if (text.trim() === '') {
    toast('Nothing to format');
    return Promise.resolve(false);
  }
  return load({ kind: 'text', text }, override);
}

export async function openDialog(): Promise<void> {
  const f = await window.api.openFileDialog();
  if (f) await openFile(f);
}

export async function openFile(f: OpenedFile): Promise<void> {
  void window.api.addRecent(f.path);
  await load({ kind: 'url', url: f.url, name: f.name, path: f.path });
}

export async function dropFile(file: File): Promise<void> {
  const path = window.api.pathForFile(file) || undefined;
  if (path) void window.api.addRecent(path);
  await load({ kind: 'file', file, name: file.name, path });
}

export async function pasteFromClipboard(): Promise<void> {
  const text = await window.api.readClipboard();
  if (!text.trim()) {
    toast('The clipboard is empty');
    return;
  }
  await loadText(text);
}

/** Format / Minify buttons: re-run smart format over the editor text. */
export async function formatEditor(minify: boolean): Promise<void> {
  const { doc } = getState();
  const ed = editor();
  const text = ed?.getText() ?? '';
  if (doc?.largeDoc && text.trim() === '') {
    toast('Large document: use "Save formatted JSON…" or "Load in editor anyway"');
    return;
  }
  await loadText(text, { minify });
}

export async function loadEditorAnyway(): Promise<void> {
  const { doc } = getState();
  if (!doc) return;
  try {
    const text = await run<string>(
      { kind: 'format', indent: settings().indent, sortKeys: false, minify: false },
      'Formatting…',
    );
    pushEditor(text);
    setState({ doc: { ...getState().doc!, largeDoc: false }, tab: 'text' });
  } catch (e) {
    if (!(e instanceof CancelledError)) toast((e as Error).message, { kind: 'error' });
  }
}

export function clearAll(): void {
  lastGood = null;
  pushEditor('');
  setState({
    doc: null,
    selected: -1,
    error: null,
    search: { ...initialSearch, opts: getState().search.opts },
    tab: 'text',
  });
}

// ───────────────────────── saving & exporting ─────────────────────────

function baseName(): string {
  const n = getState().doc?.name;
  return n ? n.replace(/\.[^.]+$/, '') : 'data';
}

async function streamToFile<T>(
  kind: 'csv' | 'json',
  suggested: string,
  body: (port: MessagePort) => ReqBody,
  stage: string,
): Promise<{ result: T; path: string } | null> {
  const target = await window.api.chooseSavePath(kind, suggested);
  if (!target) return null;
  const port = await getExportPort(target.exportId);
  try {
    const result = await run<T>(body(port), stage, {
      transfer: [port],
      onCancel: () => void window.api.cancelExport(target.exportId),
    });
    return { result, path: target.path };
  } catch (e) {
    void window.api.cancelExport(target.exportId);
    throw e;
  }
}

function showInFolderAction(path: string) {
  return { label: 'Show in folder', run: () => void window.api.showInFolder(path) };
}

export async function saveJson(): Promise<void> {
  if (!getState().doc) {
    toast('Nothing to save yet');
    return;
  }
  try {
    const r = await streamToFile<{ bytes: number }>(
      'json',
      `${baseName()}.formatted.json`,
      (port) => ({ kind: 'saveJson', indent: settings().indent, minify: false, port }),
      'Writing JSON…',
    );
    if (r)
      toast(`Saved ${formatBytes(r.result.bytes)} of formatted JSON`, { action: showInFolderAction(r.path) });
  } catch (e) {
    if (e instanceof CancelledError) toast('Save cancelled');
    else toast(`Save failed: ${(e as Error).message}`, { kind: 'error' });
  }
}

export function openCsvDialog(fromNode?: number): void {
  const { doc, selected } = getState();
  if (!doc) {
    toast('Load some JSON first');
    return;
  }
  setState({ csvDialog: { fromNode: fromNode ?? 0 }, contextMenu: null });
  void selected;
}

export function csvCandidates(fromNode: number): Promise<CsvCandidate[]> {
  return client.call<CsvCandidate[]>({ kind: 'csvCandidates', fromNode });
}

let previewJob: number | null = null;
export async function csvPreview(opts: CsvOptions): Promise<CsvPreview | null> {
  if (previewJob !== null && client.isPending(previewJob)) client.cancel(previewJob);
  const job = client.request<CsvPreview>({ kind: 'csvPreview', opts, limit: 100 });
  previewJob = job.id;
  try {
    const r = await job.promise;
    return previewJob === job.id ? r : null;
  } catch (e) {
    if (e instanceof CancelledError) return null;
    throw e;
  }
}

export async function exportCsv(opts: CsvOptions, suggestedName?: string): Promise<boolean> {
  setState({ csvDialog: null });
  try {
    const r = await streamToFile<CsvExportResult>(
      'csv',
      suggestedName ?? `${baseName()}.csv`,
      (port) => ({ kind: 'csvExport', opts, port }),
      'Writing CSV…',
    );
    if (!r) return false;
    toast(`Saved ${fmtInt(r.result.rows)} rows × ${fmtInt(r.result.columns)} columns`, {
      action: showInFolderAction(r.path),
    });
    return true;
  } catch (e) {
    if (e instanceof CancelledError) toast('Export cancelled');
    else toast(`Export failed: ${(e as Error).message}`, { kind: 'error' });
    return false;
  }
}

// ───────────────────────── tree ─────────────────────────

export function select(id: number, opts: { reveal?: boolean; scroll?: boolean } = {}): void {
  const { doc } = getState();
  if (!doc || id < 0 || id >= doc.index.n) return;
  if (opts.reveal && expandAncestors(doc.index, doc.expanded, id)) refreshVisible();
  setState({ selected: id, ...(opts.scroll || opts.reveal ? { scrollTo: { id, seq: Date.now() } } : {}) });
}

export function toggle(id: number, subtree = false): void {
  const { doc } = getState();
  if (!doc || !isContainer(doc.index, id)) return;
  const next = doc.expanded[id] ? 0 : 1;
  if (subtree) setSubtree(doc.index, doc.expanded, id, next);
  else doc.expanded[id] = next;
  refreshVisible();
}

export function setExpanded(id: number, value: 0 | 1, subtree = false): void {
  const { doc } = getState();
  if (!doc || !isContainer(doc.index, id)) return;
  if (subtree) setSubtree(doc.index, doc.expanded, id, value);
  else doc.expanded[id] = value;
  refreshVisible();
}

export function expandAll(): void {
  const { doc } = getState();
  if (!doc) return;
  setAll(doc.index, doc.expanded, 1);
  refreshVisible();
}

export function collapseAll(): void {
  const { doc } = getState();
  if (!doc) return;
  setAll(doc.index, doc.expanded, 0);
  refreshVisible();
  setState({ selected: 0, scrollTo: { id: 0, seq: Date.now() } });
}

export function expandLevel(level: number): void {
  const { doc } = getState();
  if (!doc) return;
  expandToLevel(doc.index, doc.expanded, level);
  refreshVisible();
}

// ───────────────────────── values & clipboard ─────────────────────────

export function getValue(nodeId: number, asText: boolean): Promise<string> {
  return client.call<string>({ kind: 'getValue', nodeId, asText, indent: settings().indent });
}

export async function copyText(text: string, what: string): Promise<void> {
  await window.api.writeClipboard(text);
  toast(`Copied ${what}`);
}

export async function copyNode(id: number, what: 'key' | 'value' | 'path' | 'subtree'): Promise<void> {
  const { doc } = getState();
  if (!doc) return;
  setState({ contextMenu: null });
  try {
    switch (what) {
      case 'key':
        return copyText(getKey(doc.index, id) ?? getLabel(doc.index, id), 'key');
      case 'path':
        return copyText(pathOf(doc.index, id), 'path');
      case 'value':
        return copyText(await getValue(id, true), 'value');
      case 'subtree':
        return copyText(await getValue(id, false), 'subtree as JSON');
    }
  } catch (e) {
    toast(`Copy failed: ${(e as Error).message}`, { kind: 'error' });
  }
}

// ───────────────────────── search ─────────────────────────

let searchJob: number | null = null;

export async function runSearch(query: string, opts: SearchOptions): Promise<void> {
  if (searchJob !== null && client.isPending(searchJob)) client.cancel(searchJob);
  searchJob = null;
  const base = { ...getState().search, query, opts };
  if (!getState().doc || query === '') {
    setState({
      search: { ...base, ids: new Int32Array(0), more: false, current: -1, running: false, error: null },
    });
    return;
  }
  setState({ search: { ...base, running: true, error: null } });
  const job = client.request<SearchResult>({ kind: 'search', query, opts });
  searchJob = job.id;
  try {
    const r = await job.promise;
    if (searchJob !== job.id) return;
    setState({ search: { ...getState().search, ids: r.ids, more: r.more, current: -1, running: false } });
    if (r.ids.length) goToResult(0);
  } catch (e) {
    if (searchJob !== job.id) return;
    if (e instanceof CancelledError) return;
    setState({
      search: {
        ...getState().search,
        ids: new Int32Array(0),
        more: false,
        current: -1,
        running: false,
        error: (e as Error).message,
      },
    });
  }
}

export function goToResult(k: number): void {
  const { search } = getState();
  const n = search.ids.length;
  if (!n) return;
  const current = ((k % n) + n) % n;
  setState({ search: { ...search, current }, tab: 'viewer' });
  select(search.ids[current], { reveal: true });
}

export function nextResult(dir: 1 | -1): void {
  const { search } = getState();
  goToResult(search.current < 0 ? (dir === 1 ? 0 : -1) : search.current + dir);
}
