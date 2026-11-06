import type { Req, ReqKind, Res, SanitizeError } from '@shared/types';

/** Distributive Omit, so each Req variant keeps its own fields. */
export type ReqBody = Req extends infer R ? (R extends Req ? Omit<R, 'id'> : never) : never;

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

export class WorkerError extends Error {
  constructor(
    public readonly detail: SanitizeError,
    public readonly sourceText?: string,
  ) {
    super(detail.message);
    this.name = 'WorkerError';
  }
}

export interface Job<T> {
  id: number;
  promise: Promise<T>;
}

interface Pending {
  kind: ReqKind;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (stage: string, pct?: number) => void;
}

/**
 * Jobs that run in time slices inside the worker and notice a cancel message. Everything else is
 * synchronous in the worker, so the only way to stop it is to terminate the worker.
 */
const COOPERATIVE: ReadonlySet<ReqKind> = new Set(['search', 'csvPreview', 'csvExport', 'saveJson']);

/** How long a cooperative job gets to acknowledge a cancel before the worker is terminated. */
const COOPERATIVE_GRACE_MS = 1000;

export type WorkerFactory = () => Worker;

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('../../worker/json.worker.ts', import.meta.url), {
    type: 'module',
    name: 'json-worker',
  });

/** Promise-based RPC over the JSON worker. Each request has an id; progress events carry that id. */
export class WorkerClient {
  private worker!: Worker;
  private jobs = new Map<number, Pending>();
  private nextId = 1;
  /** Called after the worker was terminated and a fresh one started (the document is gone). */
  onRespawn: (() => void) | null = null;

  constructor(private factory: WorkerFactory = defaultFactory) {
    this.spawn();
  }

  private spawn(): void {
    this.worker = this.factory();
    this.worker.onmessage = (e: MessageEvent<Res>) => this.onMessage(e.data);
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      const err = new Error(e.message || 'Worker crashed');
      for (const job of this.jobs.values()) job.reject(err);
      this.jobs.clear();
      this.restart();
    };
  }

  private onMessage(msg: Res): void {
    const job = this.jobs.get(msg.id);
    if (!job) return;
    switch (msg.kind) {
      case 'progress':
        job.onProgress?.(msg.stage, msg.pct);
        return;
      case 'loaded': {
        this.jobs.delete(msg.id);
        const { id: _id, kind: _kind, ...payload } = msg;
        job.resolve(payload);
        return;
      }
      case 'result':
        this.jobs.delete(msg.id);
        job.resolve(msg.data);
        return;
      case 'error':
        this.jobs.delete(msg.id);
        job.reject(new WorkerError(msg.error, msg.sourceText));
        return;
      case 'cancelled':
        this.jobs.delete(msg.id);
        job.reject(new CancelledError());
        return;
    }
  }

  request<T>(
    body: ReqBody,
    opts: { onProgress?: (stage: string, pct?: number) => void; transfer?: Transferable[] } = {},
  ): Job<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.jobs.set(id, {
        kind: body.kind,
        resolve: resolve as (v: unknown) => void,
        reject,
        onProgress: opts.onProgress,
      });
    });
    this.worker.postMessage({ ...body, id } as Req, opts.transfer ?? []);
    return { id, promise };
  }

  /** Convenience: request and await. */
  call<T>(body: ReqBody, opts?: Parameters<WorkerClient['request']>[1]): Promise<T> {
    return this.request<T>(body, opts).promise;
  }

  isPending(id: number): boolean {
    return this.jobs.has(id);
  }

  /**
   * Cancels a job. Cooperative jobs get a cancel message (the document stays loaded); others, or
   * cooperative jobs that don't stop in time, terminate the worker and start a fresh one.
   */
  cancel(id: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (COOPERATIVE.has(job.kind)) {
      this.worker.postMessage({ id: this.nextId++, kind: 'cancel', targetId: id } satisfies Req);
      setTimeout(() => {
        if (this.jobs.has(id)) this.restart();
      }, COOPERATIVE_GRACE_MS);
      return;
    }
    this.restart();
  }

  /** Terminates the worker, rejects everything in flight, and starts a new worker. */
  restart(): void {
    this.worker.terminate();
    const pending = [...this.jobs.values()];
    this.jobs.clear();
    for (const job of pending) job.reject(new CancelledError());
    this.spawn();
    this.onRespawn?.();
  }

  dispose(): void {
    this.worker.terminate();
    this.jobs.clear();
  }
}
