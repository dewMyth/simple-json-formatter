import { createWriteStream, type WriteStream } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import type { MessagePortMain, WebContents } from 'electron';
import type { ExportPortMsg, ExportPortReply } from '@shared/types';

interface ExportJob {
  path: string;
  tmpPath: string;
  stream?: WriteStream;
  port?: MessagePortMain;
  bytes: number;
  lastProgress: number;
  done: boolean;
  sender: WebContents;
}

const jobs = new Map<number, ExportJob>();
let nextExportId = 1;

/** Registers a destination chosen in the save dialog and returns its id. */
export function registerExport(path: string, sender: WebContents): number {
  const exportId = nextExportId++;
  // Write to a temporary sibling and rename at the end, so a cancelled export never leaves a half file.
  jobs.set(exportId, { path, tmpPath: `${path}.partial`, bytes: 0, lastProgress: 0, done: false, sender });
  return exportId;
}

function reply(job: ExportJob, msg: ExportPortReply): void {
  try {
    job.port?.postMessage(msg);
  } catch {
    /* port already closed */
  }
}

async function abort(exportId: number): Promise<void> {
  const job = jobs.get(exportId);
  if (!job || job.done) return;
  job.done = true;
  jobs.delete(exportId);
  job.port?.close();
  if (job.stream) {
    await new Promise<void>((resolve) => {
      job.stream!.once('close', () => resolve());
      job.stream!.destroy();
    });
  }
  await unlink(job.tmpPath).catch(() => undefined);
}

/** Wires the worker-facing MessagePort to a file write stream. */
export function attachExportPort(exportId: number, port: MessagePortMain): void {
  const job = jobs.get(exportId);
  if (!job) {
    port.postMessage({ type: 'error', message: 'Unknown export' } satisfies ExportPortReply);
    port.close();
    return;
  }
  job.port = port;
  job.stream = createWriteStream(job.tmpPath, { encoding: 'utf8', highWaterMark: 4 * 1024 * 1024 });
  job.stream.on('error', (err) => {
    reply(job, { type: 'error', message: err.message });
    void abort(exportId);
  });

  port.on('message', (event) => {
    const msg = event.data as ExportPortMsg;
    if (job.done) return;
    if (msg.type === 'chunk') {
      job.stream!.write(msg.data);
      job.bytes += Buffer.byteLength(msg.data, 'utf8');
      const now = Date.now();
      if (now - job.lastProgress > 100) {
        job.lastProgress = now;
        if (!job.sender.isDestroyed()) job.sender.send('export:progress', { exportId, bytes: job.bytes });
      }
    } else if (msg.type === 'end') {
      job.stream!.end(async () => {
        try {
          await rename(job.tmpPath, job.path);
          job.done = true;
          reply(job, { type: 'finished', bytes: job.bytes });
        } catch (err) {
          reply(job, { type: 'error', message: (err as Error).message });
        } finally {
          jobs.delete(exportId);
          port.close();
        }
      });
    } else if (msg.type === 'abort') {
      void abort(exportId);
    }
  });
  // The worker was terminated (cancel) or the window closed.
  port.on('close', () => {
    if (!job.done) void abort(exportId);
  });
  port.start();
}

export function cancelExport(exportId: number): Promise<void> {
  return abort(exportId);
}
