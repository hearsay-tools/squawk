import type { RunRecord } from '../../runs/store.ts';
import type { PastedContent } from '../pasted-content.ts';
import type { NativeInput, NativeInputRead } from './native-skill-input-queue.ts';
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
  /** Accepted human input awaiting native skill resolution, owned by `NativeSkillInputQueue`. */
  nativeSkillInputs?: NativeInput[];
  /** The current native skill read, owned by `NativeSkillInputQueue`. */
  nativeSkillRead?: NativeInputRead;
}

/** The fields an execution owns: `dropActive` forgets them, as each owner did before. */
const EXECUTION_FIELDS = ['memoryPausing', 'namerKey', 'forceStarted', 'nativeSkillInputs', 'nativeSkillRead'] as const satisfies ReadonlyArray<keyof RunSlot>;

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
 * run-scope bound: `release` clears them. An ended run is released once none is armed, so an
 * expiry that still has work for it (a transcript retry, a claim expiry, a request deadline) runs
 * first; the last one to end, by expiry, clear or cancel, runs the held release again.
 */
export class RunMemory {
  readonly #slots = new Map<string, RunSlot>();
  /** The release decision of an ended run held by a run-scope bound, run again when the last one ends. */
  readonly #heldReleases = new Map<string, () => void>();
  readonly liveness = new LivenessTimers(runId => {
    const retry = this.#heldReleases.get(runId);
    this.#heldReleases.delete(runId);
    retry?.();
  });

  read<K extends keyof RunSlot>(runId: string, field: K): RunSlot[K] | undefined {
    return this.#slots.get(runId)?.[field];
  }

  /** Set one field; `undefined` clears it, and a slot left empty is released. */
  write<K extends keyof RunSlot>(runId: string, field: K, value: RunSlot[K] | undefined): void {
    const slot = this.#slots.get(runId);
    if (value === undefined) {
      if (!slot) return;
      delete slot[field];
      if (Object.keys(slot).length === 0) { this.#slots.delete(runId); this.#heldReleases.delete(runId); }
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
   *  liveness bound is armed. While one is, the decision is held and runs again, reading the run
   *  afresh, when the last one ends. `read` and `live` are asked only when the run holds a slot. */
  releaseIfEnded(runId: string, read: () => Pick<RunRecord, 'status' | 'waits'> | undefined, live: () => boolean): void {
    if (!this.#slots.has(runId)) return;
    if (this.liveness.armedIn(runId, 'run').length) {
      this.#heldReleases.set(runId, () => this.releaseIfEnded(runId, read, live));
      return;
    }
    if (runMemoryReleases(read(), live())) this.release(runId);
  }

  release(runId: string): void {
    this.#slots.delete(runId);
    this.#heldReleases.delete(runId);
    this.liveness.clearScope(runId, 'run');
  }

  dispose(): void { this.#slots.clear(); this.#heldReleases.clear(); }
}
