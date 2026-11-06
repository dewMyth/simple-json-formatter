/// <reference lib="webworker" />
import type { LoadOptions, Req, Res } from '@shared/types';
import { Cancelled, LoadError, Session, utf8Length, type CancelToken } from './session';

declare const self: DedicatedWorkerGlobalScope;

const session = new Session();
const running = new Map<number, CancelToken>();

function post(msg: Res, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

const progressFor =
  (id: number) =>
  (stage: string, pct?: number): void =>
    post({ id, kind: 'progress', stage, pct });

/** Reads a byte stream with progress, into one buffer. */
async function readAll(stream: ReadableStream<Uint8Array>, total: number, id: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) {
      const pct = Math.min(100, Math.floor((received / total) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        post({ id, kind: 'progress', stage: `Reading file (${pct}%)…`, pct });
      }
    }
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function decode(bytes: Uint8Array, id: number): string {
  post({ id, kind: 'progress', stage: 'Decoding…' });
  // TextDecoder strips a UTF-8 BOM by default.
  return new TextDecoder('utf-8').decode(bytes);
}

function runLoad(id: number, text: string, bytes: number, opts: LoadOptions): void {
  const { payload, transfer } = session.load(text, bytes, opts, progressFor(id));
  post({ id, kind: 'loaded', ...payload }, transfer);
}

async function handle(req: Req): Promise<void> {
  const { id } = req;
  const token: CancelToken = { cancelled: false };
  running.set(id, token);
  try {
    switch (req.kind) {
      case 'load': {
        post({ id, kind: 'progress', stage: 'Reading file…' });
        runLoad(id, decode(new Uint8Array(req.buffer), id), req.buffer.byteLength, req.opts);
        break;
      }
      case 'loadFile': {
        post({ id, kind: 'progress', stage: 'Reading file…', pct: 0 });
        const bytes = await readAll(req.file.stream(), req.file.size, id);
        runLoad(id, decode(bytes, id), bytes.byteLength, req.opts);
        break;
      }
      case 'loadUrl': {
        post({ id, kind: 'progress', stage: 'Reading file…', pct: 0 });
        const res = await fetch(req.url);
        if (!res.ok || !res.body) throw new Error(`Could not read file (${res.status})`);
        const bytes = await readAll(res.body, Number(res.headers.get('Content-Length') ?? 0), id);
        runLoad(id, decode(bytes, id), bytes.byteLength, req.opts);
        break;
      }
      case 'loadText':
        runLoad(id, req.text, utf8Length(req.text), req.opts);
        break;
      case 'format':
        post({ id, kind: 'progress', stage: 'Formatting…' });
        post({ id, kind: 'result', data: session.format(req.indent, req.sortKeys, req.minify) });
        break;
      case 'getValue':
        post({ id, kind: 'result', data: session.getValue(req.nodeId, req.asText, req.indent) });
        break;
      case 'search': {
        const r = await session.search(req.query, req.opts, token);
        post({ id, kind: 'result', data: r }, [r.ids.buffer as ArrayBuffer]);
        break;
      }
      case 'lint':
        post({ id, kind: 'result', data: session.lint(req.text) });
        break;
      case 'csvCandidates':
        post({ id, kind: 'result', data: session.csvCandidates(req.fromNode) });
        break;
      case 'csvPreview':
        post({ id, kind: 'result', data: await session.csvPreview(req.opts, req.limit, token) });
        break;
      case 'csvExport':
        post({
          id,
          kind: 'result',
          data: await session.csvExport(req.opts, req.port, progressFor(id), token),
        });
        break;
      case 'saveJson':
        post({
          id,
          kind: 'result',
          data: await session.saveJson(req.indent, req.minify, req.port, progressFor(id), token),
        });
        break;
      case 'cancel': {
        const t = running.get(req.targetId);
        if (t) t.cancelled = true;
        break;
      }
    }
  } catch (e) {
    if (e instanceof Cancelled) post({ id, kind: 'cancelled' });
    else if (e instanceof LoadError) post({ id, kind: 'error', error: e.error, sourceText: e.sourceText });
    else {
      const message = e instanceof Error ? e.message : String(e);
      post({ id, kind: 'error', error: { message, line: 0, column: 0, offset: 0, snippet: '' } });
    }
  } finally {
    running.delete(id);
  }
}

// Requests run one at a time, in order: an async load (awaiting fetch) must finish before a
// getValue/search that depends on it. Only 'cancel' bypasses the queue, so it can reach a running job.
let queue: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<Req>) => {
  const req = e.data;
  if (req.kind === 'cancel') {
    void handle(req);
    return;
  }
  queue = queue.then(() => handle(req));
};
