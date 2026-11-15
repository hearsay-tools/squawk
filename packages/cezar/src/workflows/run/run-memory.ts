import type { RunRecord } from '../../runs/store.ts';
import type { PastedContent } from '../pasted-content.ts';
import { LivenessTimers } from './liveness-timers.ts';

/** A message `deferMessage` buffered before the session opened. `messageId` names its durable
 *  queue entry when it was accepted beside a wait. */
export interface DeferredMessage { content: PastedContent[]; messageId?: string }

/** One run's memory that is not on its record. An absent field holds its default. */
export interface RunSlot {
  /** Messages buffered in the dequeue → session-open gap (open-mercato/cezar#472), owned by `QueuedInput`. */
  deferredMessages?: DeferredMessage[];
  /** The last attachment number written, owned by `AttachmentWriter`. Absent: seed from disk. */
  imageSeq?: number;
  /** The last "retained; continuation unavailable" note, owned by `WakeRetries`. */
  retainedNote?: string;
  /** A Stop accepted for the worker's current generation, owned by `WorkerExecutions`. */
  workerStopped?: true;
  /** The memory guard is closing this execution's session, owned by `MemoryGuard`. */
  memoryPausing?: true;
  /** The last live-refresh namer inputs, owned by `TurnBookkeeper`. */
  namerKey?: string;
  /** A forced start that bypasses the spawn-time gate, owned by `RunLine`. */
  forceStarted?: true;
}

/** The fields an execution owns: `dropActive` forgets them, as each owner did before. */
const EXECUTION_FIELDS = ['memoryPausing', 'namerKey', 'forceStarted'] as const satisfies ReadonlyArray<keyof RunSlot>;

/** The statuses a run ends at. `review` is not one: a settled turn rests there and takes feedback. */
const FINAL_STATUSES: ReadonlySet<RunRecord['status']> = new Set(['done', 'failed', 'cancelled']);

/**
 * Whether a run's memory can go: the run is gone, or it ended at a final status with no open wait,
 * and nothing in this manager executes, starts or queues it. A usage-limit hold is `waiting`, so it
 * keeps its memory until its resume (hearsay-tools/squawk#2064).
 */
export function runMemoryReleases(run: Pick<RunRecord, 'status' | 'waits'> | undefined, live: boolean): boolean {
  if (!run) return true;
  return !live && FINAL_STATUSES.has(run.status) && !run.waits?.length;
}

/**
 * The one owner of per-run memory that outlives an execution (ADR 0064). Each run has one slot,
 * opened by its first write and released when the run ends (`runMemoryReleases`), when it is
 * deleted and when the manager is disposed. A new per-run field goes into `RunSlot`, never into a
 * new map on a run module: the `run-memory-field-outside-owner` rule refuses one.
 *
 * It also holds the manager's liveness bounds (hearsay-tools/squawk#3662). A released run holds no
 * run-scope bound: `release` clears them, and an ended run is released only once none is armed,
 * so an expiry that still has work for it (a transcript retry, a claim expiry, a request deadline)
 * runs first.
 */
export class RunMemory {
  readonly #slots = new Map<string, RunSlot>();

  constructor(readonly liveness = new LivenessTimers()) {}

  read<K extends keyof RunSlot>(runId: string, field: K): RunSlot[K] | undefined {
    return this.#slots.get(runId)?.[field];
  }

  /** Set one field; `undefined` clears it, and a slot left empty is released. */
  write<K extends keyof RunSlot>(runId: string, field: K, value: RunSlot[K] | undefined): void {
    const slot = this.#slots.get(runId);
    if (value === undefined) {
      if (!slot) return;
      delete slot[field];
      if (Object.keys(slot).length === 0) this.#slots.delete(runId);
      return;
    }
    const next = slot ?? {};
    next[field] = value;
    if (!slot) this.#slots.set(runId, next);
  }

  /** Forget what the run's last execution held: called when it leaves the active registry. */
  forgetExecution(runId: string): void {
    for (const field of EXECUTION_FIELDS) this.write(runId, field, undefined);
  }

  /** Whether the run holds a slot. */
  holds(runId: string): boolean { return this.#slots.has(runId); }

  /** Release the run's slot when `runMemoryReleases` says the run has ended and no run-scope
   *  liveness bound is armed. `live` is asked only when the run holds a slot. */
  releaseIfEnded(runId: string, run: Pick<RunRecord, 'status' | 'waits'> | undefined, live: () => boolean): void {
    if (!this.#slots.has(runId) || this.liveness.armedIn(runId, 'run').length) return;
    if (runMemoryReleases(run, live())) this.release(runId);
  }

  release(runId: string): void {
    this.#slots.delete(runId);
    this.liveness.clearScope(runId, 'run');
  }

  dispose(): void { this.#slots.clear(); }
}
