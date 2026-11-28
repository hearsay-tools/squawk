import { rmSync } from 'node:fs';
import { MessageChannel, receiveMessageOnPort, Worker, type MessagePort } from 'node:worker_threads';
import { loadTranscriptFacts, type FactsLoadResult } from './transcript-facts-load.ts';
import { RESULT_SLOT, revokeSidecar, SIGNAL_BYTES, tempSidecarPath, type SidecarCommit } from './transcript-facts-sidecar.ts';
import type { FactsJobMessage, FactsJobReply } from './transcript-facts-worker.ts';

export const REFRESH_FACTS = Symbol('transcript changed');
const JOB_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
interface Job<T> {
  runId: string;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  attempts: number;
  queued: boolean;
  prev?: Job<T> | undefined;
  next?: Job<T> | undefined;
  value?: T | undefined;
  error?: Error | undefined;
  port?: MessagePort | undefined;
  signal?: Int32Array | undefined;
  /** The temp file the worker writes this job's sidecar to. */
  tmp?: string | undefined;
  timer?: NodeJS.Timeout;
}

/** One owner per run, one active worker load. Both receive paths settle the same job. */
export class TranscriptFactsQueue<T> {
  private readonly jobs = new Map<string, Job<T>>();
  private pendingHead?: Job<T> | undefined;
  private pendingTail?: Job<T> | undefined;
  private active?: Job<T> | undefined;
  private worker?: Worker | undefined;
  private workerLifecycle?: Int32Array | undefined;
  private dispatch?: NodeJS.Immediate | undefined;
  private stopped = false;

  constructor(
    private readonly dataDir: string,
    private readonly accept: (runId: string, loaded: FactsLoadResult | undefined, sidecar?: SidecarCommit) => T | typeof REFRESH_FACTS,
    private readonly cached?: (runId: string) => T | undefined,
    /** Where the worker commits the sidecar of a load that needs one; absent: it commits none. */
    private readonly sidecarPath?: (runId: string) => string,
  ) {}

  has(runId: string): boolean { return this.jobs.has(runId); }

  request(runId: string, demand = true): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Transcript facts queue stopped'));
    let job = this.jobs.get(runId);
    if (!job) {
      let resolve!: (value: T) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
      job = { runId, promise, resolve, reject, attempts: 0, queued: false };
      // Synchronous callers may take ownership without ever observing this promise.
      void promise.catch(() => undefined);
      this.jobs.set(runId, job);
      this.enqueueBack(job);
    }
    if (demand && job !== this.active) {
      this.enqueueFront(job);
    }
    this.schedule();
    return job.promise;
  }

  /** Exceptional compatibility path: take a queued job, but NEVER refold an active one. */
  join(runId: string): T {
    if (this.stopped) throw new Error('Transcript facts queue stopped');
    void this.request(runId);
    const job = this.jobs.get(runId)!;
    if (job !== this.active) {
      this.removePending(job);
      this.complete(job, { result: loadTranscriptFacts(this.dataDir, runId) });
    }
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    while (this.jobs.get(runId) === job) {
      if (!this.active) this.start(job);
      if (this.jobs.get(runId) !== job) break;
      const active = this.active!;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || Atomics.wait(active.signal!, RESULT_SLOT, 0, remaining) === 'timed-out') {
        this.fail(new Error(`Transcript facts worker timed out for ${runId}`));
        break;
      }
      const received = receiveMessageOnPort(active.port!);
      if (!received) {
        this.fail(new Error(`Transcript facts worker published no result for ${runId}`));
        break;
      }
      this.complete(active, received.message as FactsJobReply);
    }
    if (job.error) throw job.error;
    return job.value as T;
  }

  /** The caller writes this run's sidecar itself: the active worker job must not overwrite it. */
  revoke(runId: string): void {
    if (this.active?.runId === runId && this.active.signal) revokeSidecar(this.active.signal);
  }

  forget(runId: string): void {
    const job = this.jobs.get(runId);
    if (!job) return;
    if (job === this.active) this.disposeWorker();
    this.settle(job, new Error(`Transcript facts cancelled for ${runId}`));
  }

  stop(): void {
    this.stopped = true;
    this.fail(new Error('Transcript facts queue stopped'));
  }

  private enqueueBack(job: Job<T>): void {
    if (job.queued) return;
    job.prev = this.pendingTail;
    job.next = undefined;
    if (this.pendingTail) this.pendingTail.next = job;
    else this.pendingHead = job;
    this.pendingTail = job;
    job.queued = true;
  }

  private enqueueFront(job: Job<T>): void {
    this.removePending(job);
    job.prev = undefined;
    job.next = this.pendingHead;
    if (this.pendingHead) this.pendingHead.prev = job;
    else this.pendingTail = job;
    this.pendingHead = job;
    job.queued = true;
  }

  private removePending(job: Job<T>): void {
    if (!job.queued) return;
    if (job.prev) job.prev.next = job.next;
    else this.pendingHead = job.next;
    if (job.next) job.next.prev = job.prev;
    else this.pendingTail = job.prev;
    job.prev = undefined;
    job.next = undefined;
    job.queued = false;
  }

  private schedule(): void {
    if (this.stopped || this.dispatch) return;
    // Yield even for cached sidecars, and let synchronous callers take pending ownership.
    this.dispatch = setImmediate(() => {
      this.dispatch = undefined;
      if (this.active) return;
      const next = this.pendingHead;
      if (next) this.start(next);
      else this.disposeWorker();
    });
  }

  private createWorker(): Worker {
    const source = import.meta.url.endsWith('.ts');
    const entry = new URL(`./transcript-facts-worker.${source ? 'ts' : 'js'}`, import.meta.url);
    // --import tsx inherited from the parent does not register TS inside a Worker reliably.
    // Register in the worker itself; never inherit Vitest/debugger flags.
    const url = source ? new URL(`data:text/javascript,${encodeURIComponent(
      `import { register } from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))}; register(); await import(${JSON.stringify(entry.href)});`,
    )}`) : entry;
    const lifecycle = new Int32Array(new SharedArrayBuffer(8));
    const worker = new Worker(url, { execArgv: [], workerData: { lifecycle: lifecycle.buffer } });
    this.workerLifecycle = lifecycle;
    worker.on('error', (error) => { if (this.worker === worker) this.fail(error, true); });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.fail(new Error(`Transcript facts worker exited (${code})`), true);
    });
    return worker;
  }

  private start(job: Job<T>): void {
    this.removePending(job);
    this.active = job;
    job.attempts++;
    try {
      const cached = this.cached?.(job.runId);
      if (cached !== undefined) { this.settle(job, undefined, cached); return; }
      this.worker ??= this.createWorker();
      const { port1, port2 } = new MessageChannel();
      job.port = port1;
      job.signal = new Int32Array(new SharedArrayBuffer(SIGNAL_BYTES));
      port1.once('message', (reply: FactsJobReply) => this.complete(job, reply));
      job.timer = setTimeout(() => this.fail(new Error(`Transcript facts worker timed out for ${job.runId}`)), JOB_TIMEOUT_MS);
      const sidecar = this.sidecarPath?.(job.runId);
      job.tmp = sidecar && tempSidecarPath(sidecar);
      const message: FactsJobMessage = { dataDir: this.dataDir, runId: job.runId, port: port2,
        signal: job.signal.buffer as SharedArrayBuffer, ...(sidecar ? { sidecar, tmp: job.tmp } : {}) };
      try { this.worker.postMessage(message, [port2]); } catch (error) { port2.close(); throw error; }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
  }

  private complete(job: Job<T>, reply: FactsJobReply): void {
    if (this.jobs.get(job.runId) !== job) return;
    if ('error' in reply) { this.fail(new Error(reply.error)); return; }
    try {
      const value = this.accept(job.runId, reply.result, reply.sidecar);
      if (value === REFRESH_FACTS) {
        this.release(job);
        if (job.attempts >= MAX_ATTEMPTS) {
          this.settle(job, new Error(`Transcript keeps changing for ${job.runId}`));
        } else {
          this.enqueueFront(job);
          this.schedule();
        }
      } else this.settle(job, undefined, value);
    } catch (error) { this.settle(job, error instanceof Error ? error : new Error(String(error))); }
  }

  private release(job: Job<T>): void {
    clearTimeout(job.timer);
    job.port?.close();
    job.port = undefined;
    job.signal = undefined;
    job.tmp = undefined;
    if (this.active === job) this.active = undefined;
  }

  private settle(job: Job<T>, error?: Error, value?: T): void {
    this.release(job);
    this.jobs.delete(job.runId);
    this.removePending(job);
    job.error = error;
    job.value = value;
    if (error) job.reject(error); else job.resolve(value as T);
    this.schedule();
  }

  /** `exited`: the worker already stopped on its own ('error' or 'exit'). */
  private disposeWorker(exited = false): void {
    // Revoke before terminating: a terminated worker could leave a rename half-signalled.
    if (this.active?.signal) revokeSidecar(this.active.signal, !exited);
    const tmp = this.active?.tmp;
    const worker = this.worker;
    const lifecycle = this.workerLifecycle;
    this.worker = undefined;
    this.workerLifecycle = undefined;
    if (!worker) return;
    // Terminating mid-write leaves the job's temp file: remove it once the worker writes no more.
    if (tmp) {
      if (exited) removeTemp(tmp);
      else worker.once('exit', () => removeTemp(tmp));
    }
    if (lifecycle) {
      Atomics.store(lifecycle, 1, 1);
      if (Atomics.load(lifecycle, 0) === 0) {
        // Node 24.15 can abort the process if terminate() interrupts CJS import
        // parsing. Let finite startup imports finish, then the worker closes
        // without processing buffered jobs. The worker stays referenced: exiting
        // the parent mid-import aborts the same way. Keep emergency cleanup bounded.
        const cleanup = setTimeout(() => { void worker.terminate().catch(() => undefined); }, JOB_TIMEOUT_MS);
        cleanup.unref();
        worker.once('exit', () => clearTimeout(cleanup));
        return;
      }
    }
    void worker.terminate().catch(() => undefined);
  }

  private fail(error: Error, exited = false): void {
    this.disposeWorker(exited);
    if (this.dispatch) clearImmediate(this.dispatch);
    this.dispatch = undefined;
    for (const job of this.jobs.values()) this.settle(job, error);
  }
}

function removeTemp(path: string): void {
  try { rmSync(path, { force: true }); } catch { /* removeHistory removes it with the run */ }
}
