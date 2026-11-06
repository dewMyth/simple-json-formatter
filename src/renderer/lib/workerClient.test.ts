import type { Req, Res } from '@shared/types';
import { CancelledError, WorkerClient, WorkerError } from './workerClient';

/** A fake worker whose behaviour is scripted per request kind. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<Res>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  received: Req[] = [];
  constructor() {
    FakeWorker.instances.push(this);
  }
  emit(msg: Res): void {
    this.onmessage?.({ data: msg } as MessageEvent<Res>);
  }
  postMessage(req: Req): void {
    this.received.push(req);
    queueMicrotask(() => {
      switch (req.kind) {
        case 'getValue':
          this.emit({ id: req.id, kind: 'progress', stage: 'Working…', pct: 50 });
          this.emit({ id: req.id, kind: 'result', data: `value ${req.nodeId}` });
          break;
        case 'lint':
          this.emit({
            id: req.id,
            kind: 'error',
            error: { message: 'bad', line: 1, column: 2, offset: 1, snippet: '' },
          });
          break;
        case 'cancel':
          this.emit({ id: req.targetId, kind: 'cancelled' });
          break;
        default:
          break; // never answers (a long job)
      }
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

const make = () => {
  FakeWorker.instances = [];
  return new WorkerClient(() => new FakeWorker() as unknown as Worker);
};

describe('WorkerClient', () => {
  it('resolves results and reports progress', async () => {
    const c = make();
    const stages: string[] = [];
    await expect(
      c.call({ kind: 'getValue', nodeId: 3, asText: true }, { onProgress: (s) => stages.push(s) }),
    ).resolves.toBe('value 3');
    expect(stages).toEqual(['Working…']);
  });

  it('rejects with WorkerError on error', async () => {
    const c = make();
    const e = await c.call({ kind: 'lint', text: 'x' }).catch((x) => x);
    expect(e).toBeInstanceOf(WorkerError);
    expect((e as WorkerError).detail.column).toBe(2);
  });

  it('cancels cooperative jobs with a message, keeping the worker', async () => {
    const c = make();
    const job = c.request({
      kind: 'search',
      query: 'a',
      opts: { keys: true, values: true, caseSensitive: false, wholeWord: false, regex: false },
    });
    c.cancel(job.id);
    await expect(job.promise).rejects.toBeInstanceOf(CancelledError);
    expect(FakeWorker.instances.length).toBe(1);
    expect(FakeWorker.instances[0].terminated).toBe(false);
  });

  it('cancels synchronous jobs by terminating and respawning', async () => {
    const c = make();
    let respawned = 0;
    c.onRespawn = () => respawned++;
    const job = c.request({ kind: 'loadText', text: '{}', opts: {} as never });
    const other = c.request({ kind: 'format', indent: 2, sortKeys: false, minify: false });
    expect(c.isPending(job.id)).toBe(true);
    c.cancel(job.id);
    await expect(job.promise).rejects.toBeInstanceOf(CancelledError);
    await expect(other.promise).rejects.toBeInstanceOf(CancelledError);
    expect(FakeWorker.instances[0].terminated).toBe(true);
    expect(FakeWorker.instances.length).toBe(2);
    expect(respawned).toBe(1);
    // the new worker works
    await expect(c.call({ kind: 'getValue', nodeId: 1, asText: true })).resolves.toBe('value 1');
  });

  it('cancelling an unknown job is a no-op', () => {
    const c = make();
    c.cancel(12345);
    expect(FakeWorker.instances.length).toBe(1);
  });

  it('a crashed worker rejects pending jobs and restarts', async () => {
    const c = make();
    const job = c.request({ kind: 'format', indent: 2, sortKeys: false, minify: false });
    FakeWorker.instances[0].onerror?.({ message: 'boom', preventDefault() {} } as ErrorEvent);
    await expect(job.promise).rejects.toThrow('boom');
    expect(FakeWorker.instances.length).toBe(2);
  });

  it('strips id/kind from loaded payloads', async () => {
    const c = make();
    const job = c.request<{ fixes: string[] }>({ kind: 'loadText', text: '{}', opts: {} as never });
    FakeWorker.instances[0].emit({ id: job.id, kind: 'loaded', fixes: ['x'] } as unknown as Res);
    const r = await job.promise;
    expect(r).toEqual({ fixes: ['x'] });
  });
});
