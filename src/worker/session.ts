import type {
  CsvCandidate,
  CsvExportResult,
  CsvOptions,
  CsvPreview,
  ExportPortMsg,
  ExportPortReply,
  Indent,
  LoadOptions,
  LoadedPayload,
  SanitizeError,
  SearchOptions,
  SearchResult,
} from '@shared/types';
import { NodeType } from '@shared/types';
import {
  CSV_PROGRESS_EVERY,
  EXPORT_CHUNK_CHARS,
  STREAM_SERIALIZE_BYTES,
  WORKER_SLICE_MS,
} from '@shared/constants';
import { jsonPath } from '@shared/path';
import { describeParseError, sanitize } from './sanitize';
import { countLines } from './escapeScanner';
import { buildIndex, indexTransferables } from './indexBuilder';
import { formatJson, indentString, serialize, sortKeysDeep, valueToText } from './format';
import { searchIter } from './search';
import {
  columnWarnings,
  columnsIter,
  countRows,
  DEFAULT_CSV_OPTIONS,
  generateCsv,
  getRecords,
  previewRows,
} from './csv';
import { findArrays } from './flatten';

export type Progress = (stage: string, pct?: number) => void;

export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

export interface CancelToken {
  cancelled: boolean;
}

/** Thrown by load when the input can't be parsed. */
export class LoadError extends Error {
  constructor(
    public readonly error: SanitizeError,
    public readonly sourceText?: string,
  ) {
    super(error.message);
  }
}

const yieldToLoop = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Yields to the worker's event loop when the current slice has run long enough, and checks for cancel. */
class Slicer {
  private start = performance.now();
  constructor(private token: CancelToken) {}
  async tick(): Promise<void> {
    if (performance.now() - this.start < WORKER_SLICE_MS) return;
    await yieldToLoop();
    if (this.token.cancelled) throw new Cancelled();
    this.start = performance.now();
  }
}

export function utf8Length(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

interface Doc {
  root: unknown;
  lossless: boolean;
  n: number;
  type: Uint8Array;
  parent: Int32Array;
  subtreeEnd: Int32Array;
  childCount: Int32Array;
  keyId: Int32Array;
  arrayIndex: Int32Array;
  keyList: string[];
  values: unknown[];
  sourceBytes: number;
}

function csvColumnsKey(o: CsvOptions): string {
  return JSON.stringify([
    o.sourceNode,
    o.separator,
    o.maxDepth,
    o.arrayMode,
    o.arrayOverrides,
    o.indexCap,
    o.explodePath,
  ]);
}

/** Worker-side state: the parsed document (source of truth) and every operation on it. */
export class Session {
  doc: Doc | null = null;
  private columnsCache: { key: string; columns: string[] } | null = null;

  /** Sanitise → parse → index → format. Returns the payload and its transfer list. */
  load(
    text: string,
    bytes: number,
    opts: LoadOptions,
    progress: Progress,
  ): { payload: LoadedPayload; transfer: ArrayBuffer[] } {
    const t0 = performance.now();
    progress('Cleaning up escapes…');
    progress('Parsing…');
    const res = sanitize(text, opts);
    if (!res.ok) {
      throw new LoadError(
        res.error!,
        opts.editorMaxBytes === 0 || bytes <= opts.editorMaxBytes ? text : undefined,
      );
    }
    const parseMs = performance.now() - t0;
    let root = res.value;
    if (opts.sortKeys) {
      progress('Sorting keys…');
      root = sortKeysDeep(root);
    }

    progress('Building tree…', 0);
    const built = buildIndex(root, (pct) => progress(`Building tree (${pct}%)…`, pct));
    const idx = built.index;

    let formatted: string | undefined;
    let formattedBytes = bytes;
    if (opts.editorMaxBytes > 0 && bytes <= opts.editorMaxBytes * 1.5) {
      progress('Formatting…');
      const out = formatJson(root, opts.indent, opts.minify, res.usedLossless);
      // UTF-16 length is a close enough estimate of the byte size for the threshold.
      formattedBytes = out.length;
      if (out.length <= opts.editorMaxBytes) formatted = out;
    }

    this.doc = {
      root,
      lossless: res.usedLossless,
      n: idx.n,
      // Keep copies: the originals are transferred to the UI.
      type: idx.type.slice(),
      parent: idx.parent.slice(),
      subtreeEnd: idx.subtreeEnd.slice(),
      childCount: idx.childCount.slice(),
      keyId: idx.keyId.slice(),
      arrayIndex: idx.arrayIndex.slice(),
      keyList: built.keyList,
      values: built.values,
      sourceBytes: bytes,
    };
    this.columnsCache = null;

    const payload: LoadedPayload = {
      index: idx,
      fixes: res.fixes,
      stats: {
        bytes,
        lines: formatted !== undefined ? countLines(formatted) : countLines(text),
        nodes: idx.n,
        maxDepth: idx.maxDepth,
        parseMs: Math.round(parseMs),
        totalMs: Math.round(performance.now() - t0),
      },
      formatted,
      formattedBytes,
      usedLossless: res.usedLossless,
    };
    return { payload, transfer: indexTransferables(idx) };
  }

  private requireDoc(): Doc {
    if (!this.doc) throw new Error('No document loaded');
    return this.doc;
  }

  format(indent: Indent, sortKeys: boolean, minify: boolean): string {
    const doc = this.requireDoc();
    const v = sortKeys ? sortKeysDeep(doc.root) : doc.root;
    return formatJson(v, indent, minify, doc.lossless);
  }

  getValue(nodeId: number, asText: boolean, indent: Indent = 2): string {
    const doc = this.requireDoc();
    if (nodeId < 0 || nodeId >= doc.n) throw new Error(`No node ${nodeId}`);
    const v = doc.values[nodeId];
    return asText ? valueToText(v, indent) : formatJson(v, indent, false, true);
  }

  pathOf(nodeId: number): string {
    const doc = this.requireDoc();
    return jsonPath(doc, nodeId, (k) => doc.keyList[k]);
  }

  async search(query: string, opts: SearchOptions, token: CancelToken): Promise<SearchResult> {
    const doc = this.requireDoc();
    const it = searchIter(doc, query, opts);
    const slicer = new Slicer(token);
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
      await slicer.tick();
    }
  }

  /** Strict JSON validity for the editor's linter. */
  lint(text: string): SanitizeError | null {
    try {
      JSON.parse(text);
      return null;
    } catch (e) {
      return describeParseError(text.replace(/\r\n?/g, '\n'), e as Error);
    }
  }

  /** Arrays of objects under `fromNode`, largest first, plus the node itself. */
  csvCandidates(fromNode: number): CsvCandidate[] {
    const doc = this.requireDoc();
    const { type, subtreeEnd, childCount } = doc;
    const end = subtreeEnd[fromNode];
    const out: CsvCandidate[] = [];
    for (let i = fromNode; i < end; i++) {
      if (type[i] !== NodeType.Array || childCount[i] === 0) continue;
      let objects = 0;
      let seen = 0;
      for (let c = i + 1; seen < 20 && c < subtreeEnd[i]; c = subtreeEnd[c], seen++) {
        if (type[c] === NodeType.Object) objects++;
      }
      if (objects * 2 >= seen)
        out.push({ nodeId: i, path: this.pathOf(i), length: childCount[i], kind: 'objects' });
      if (out.length > 5000) break;
    }
    out.sort((a, b) => b.length - a.length || a.nodeId - b.nodeId);
    const top = out.slice(0, 200);
    if (!top.some((c) => c.nodeId === fromNode)) {
      const t = type[fromNode];
      const kind: CsvCandidate['kind'] =
        t === NodeType.Object ? 'object' : t === NodeType.Array ? 'primitives' : 'mixed';
      top.push({
        nodeId: fromNode,
        path: this.pathOf(fromNode),
        length: t === NodeType.Array ? childCount[fromNode] : 1,
        kind,
      });
    }
    return top;
  }

  private async columnsFor(
    opts: CsvOptions,
    records: unknown[],
    token: CancelToken,
    progress?: Progress,
  ): Promise<string[]> {
    const key = csvColumnsKey(opts);
    if (this.columnsCache?.key === key) return this.columnsCache.columns;
    const slicer = new Slicer(token);
    const it = columnsIter(records, opts);
    for (;;) {
      const r = it.next();
      if (r.done) {
        this.columnsCache = { key, columns: r.value };
        return r.value;
      }
      progress?.('Analysing columns…', Math.round((r.value / Math.max(1, records.length)) * 100));
      await slicer.tick();
    }
  }

  private records(opts: CsvOptions): unknown[] {
    const doc = this.requireDoc();
    if (opts.sourceNode < 0 || opts.sourceNode >= doc.n) throw new Error('Invalid CSV source');
    return getRecords(doc.values[opts.sourceNode]);
  }

  async csvPreview(options: CsvOptions, limit: number, token: CancelToken): Promise<CsvPreview> {
    const opts = { ...DEFAULT_CSV_OPTIONS, ...options };
    const records = this.records(opts);
    const columns = await this.columnsFor(opts, records, token);
    const arrays = findArrays(records, opts.separator);
    return {
      columns: columns.slice(0, 1000),
      rows: previewRows(records, columns.slice(0, 1000), opts, limit),
      totalRows: countRows(records, opts),
      totalColumns: columns.length,
      warnings: columnWarnings(columns.length),
      explodeCandidates: arrays.explode,
      arrayPaths: arrays.arrayPaths,
    };
  }

  async csvExport(
    options: CsvOptions,
    port: MessagePort,
    progress: Progress,
    token: CancelToken,
  ): Promise<CsvExportResult> {
    const opts = { ...DEFAULT_CSV_OPTIONS, ...options };
    const records = this.records(opts);
    try {
      const columns = await this.columnsFor(opts, records, token, progress);
      const total = countRows(records, opts);
      const slicer = new Slicer(token);
      const sink = new ChunkSink(port);
      let rows = 0;
      let lines = 0;
      for (const line of generateCsv(records, columns, opts)) {
        sink.write(line);
        lines++;
        // the first line is the header when enabled
        if (!opts.header || lines > 1) {
          rows++;
          if (rows % CSV_PROGRESS_EVERY === 0) {
            progress(
              `Writing CSV (${rows.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} rows)…`,
              Math.round((rows / Math.max(1, total)) * 100),
            );
          }
        }
        await slicer.tick();
      }
      progress(`Writing CSV (${rows.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} rows)…`, 100);
      const bytes = await sink.end();
      return { rows, columns: columns.length, bytes };
    } catch (e) {
      port.postMessage({ type: 'abort' } satisfies ExportPortMsg);
      throw e;
    }
  }

  async saveJson(
    indent: Indent,
    minify: boolean,
    port: MessagePort,
    progress: Progress,
    token: CancelToken,
  ): Promise<{ bytes: number }> {
    const doc = this.requireDoc();
    try {
      const sink = new ChunkSink(port);
      const ind = indentString(indent, minify);
      progress('Writing JSON…', 0);
      if (!doc.lossless && doc.sourceBytes < STREAM_SERIALIZE_BYTES) {
        const text = JSON.stringify(doc.root, null, ind || undefined) ?? 'null';
        for (let i = 0; i < text.length; i += EXPORT_CHUNK_CHARS)
          sink.write(text.slice(i, i + EXPORT_CHUNK_CHARS));
      } else {
        // Large documents: stream so there is never one giant intermediate string.
        const slicer = new Slicer(token);
        let sent = 0;
        for (const chunk of serialize(doc.root, ind)) {
          sink.write(chunk);
          sent += chunk.length;
          progress('Writing JSON…', Math.min(99, Math.round((sent / Math.max(1, doc.sourceBytes)) * 100)));
          await slicer.tick();
        }
      }
      return { bytes: await sink.end() };
    } catch (e) {
      port.postMessage({ type: 'abort' } satisfies ExportPortMsg);
      throw e;
    }
  }
}

/** Batches text into ~1 MB chunks for the export port and waits for main to confirm the file is written. */
class ChunkSink {
  private buf = '';
  private reply: Promise<ExportPortReply>;

  constructor(private port: MessagePort) {
    this.reply = new Promise((resolve) => {
      port.onmessage = (e: MessageEvent<ExportPortReply>) => resolve(e.data);
    });
  }

  write(s: string): void {
    this.buf += s;
    if (this.buf.length >= EXPORT_CHUNK_CHARS) this.flush();
  }

  private flush(): void {
    if (!this.buf) return;
    this.port.postMessage({ type: 'chunk', data: this.buf } satisfies ExportPortMsg);
    this.buf = '';
  }

  async end(): Promise<number> {
    this.flush();
    this.port.postMessage({ type: 'end' } satisfies ExportPortMsg);
    const r = await this.reply;
    this.port.close();
    if (r.type === 'error') throw new Error(r.message);
    return r.bytes;
  }
}
