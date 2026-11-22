/**
 * The run lifecycle (.ai/specs/2026-11-21-run-lifecycle-and-store-ports.md § The lifecycle): the
 * typed events a run store publishes after it writes, and nothing else. The lifecycle reports what
 * the store wrote; it never writes (ADR 0056, ADR 0064). `RunStore.open` builds one and exposes it
 * as `store.lifecycle`, typed by the port `RunLifecycleSource`, so nothing else publishes to it.
 *
 * Delivery is synchronous, in subscription order, at the moment the store writes.
 * A listener that throws is logged with its event type and run id, and the next listener runs. A
 * listener may return a promise: it is not awaited, and a rejection is logged. A publish from inside
 * a listener is delivered at once, before the outer delivery continues, as `EventEmitter` does.
 * There is no replay: a listener gets no current runs when it subscribes.
 */
import type { RunStatus } from '@open-mercato/cezar-contract';
import type { RunExitId } from './run-exits.ts';
import type { CommitSource } from './run-persistence.ts';
import type { RunEvent, RunRecord } from './store.ts';

/** Why a `run.updated` fired beside the write itself: today's `CommitSource`, or `conflict` when
 *  another writer's row replaced the record. */
export type RunUpdateSource = CommitSource | 'conflict';

/** What moved a run's status: the exit `applyExit` applied, `conflict` when another writer's
 *  status won, or `patch` when a write set `status` without an exit (test fixtures only). */
export type RunStatusCause = RunExitId | 'conflict' | 'patch';

export interface RunLifecycleEvents {
  'run.created': { run: RunRecord };
  /** `run` is this write's record, a value: a shallow frozen copy on a commit; on a debounced write,
   *  a republish or a conflict, the held record, which a later write changes in place. Never write
   *  into it or keep it; re-read through the store for the current record. `before` is a shallow
   *  frozen copy of the record taken at the entry of the write path. */
  'run.updated': { run: RunRecord; before: Readonly<RunRecord>; source?: RunUpdateSource };
  /** Follows the `run.updated` of the same write, with the same `run`; `from` and `to` are this
   *  write's. */
  'run.status-changed': { run: RunRecord; exit: RunStatusCause; from: RunStatus; to: RunStatus };
  'run.deleted': { runId: string };
  'run.event': { runId: string; event: RunEvent };
  'store.closed': Record<string, never>;
}
export type RunLifecycleEventType = keyof RunLifecycleEvents;

export type RunLifecycleHandler<K extends RunLifecycleEventType> = (payload: RunLifecycleEvents[K]) => void | Promise<void>;
/** One subscriber's handlers, by event type. */
export type RunLifecycleHandlers = { [K in RunLifecycleEventType]?: RunLifecycleHandler<K> };

/** The port a feature subscribes through. */
export interface RunLifecycleSource {
  /** Subscribe `handlers`; the returned function unsubscribes them. */
  subscribe(handlers: RunLifecycleHandlers): () => void;
}

export class RunLifecycle implements RunLifecycleSource {
  private readonly subscribers: Array<{ handlers: RunLifecycleHandlers }> = [];

  subscribe(handlers: RunLifecycleHandlers): () => void {
    const entry = { handlers: { ...handlers } };
    this.subscribers.push(entry);
    return () => {
      const index = this.subscribers.indexOf(entry);
      if (index >= 0) this.subscribers.splice(index, 1);
    };
  }

  /** Deliver one event to every subscriber that handles it, in subscription order. A subscriber
   *  added during the delivery gets the next event; one removed during it gets no more. */
  publish<K extends RunLifecycleEventType>(type: K, payload: RunLifecycleEvents[K]): void {
    for (const entry of [...this.subscribers]) {
      if (!this.subscribers.includes(entry)) continue;
      const handler = entry.handlers[type] as RunLifecycleHandler<K> | undefined;
      if (!handler) continue;
      try {
        const result = handler(payload);
        if (result instanceof Promise) result.catch((error: unknown) => logListenerFailure(type, payload, error));
      } catch (error) {
        logListenerFailure(type, payload, error);
      }
    }
  }
}

/** A shallow frozen copy of `run`: a write's `before`. */
export function snapshotRun(run: RunRecord): Readonly<RunRecord>;
export function snapshotRun(run: RunRecord | undefined): Readonly<RunRecord> | undefined;
export function snapshotRun(run: RunRecord | undefined): Readonly<RunRecord> | undefined {
  return run && Object.freeze({ ...run });
}

/**
 * Publish one record write: `run.created` when there was no record before it, else `run.updated`,
 * then `run.status-changed` when the status moved. `exit` is the exit the write applied; a status
 * no exit wrote is a `patch`.
 */
export function publishRunWrite(lifecycle: RunLifecycle, run: RunRecord, before: Readonly<RunRecord> | undefined,
  source?: RunUpdateSource, exit?: RunExitId): void {
  if (!before) { lifecycle.publish('run.created', { run }); return; }
  // `to` is read before any listener runs: a nested write may change a held record, and publishes
  // its own change.
  const to = run.status;
  lifecycle.publish('run.updated', { run, before, ...(source ? { source } : {}) });
  if (before.status === to) return;
  const cause = source === 'conflict' ? 'conflict' : exit ?? 'patch';
  lifecycle.publish('run.status-changed', { run, exit: cause, from: before.status, to });
}

function runIdOf(payload: unknown): string | undefined {
  const value = payload as { runId?: unknown; run?: { id?: unknown } };
  const id = value.runId ?? value.run?.id;
  return typeof id === 'string' ? id : undefined;
}

function logListenerFailure(type: RunLifecycleEventType, payload: unknown, error: unknown): void {
  const runId = runIdOf(payload);
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[hsq] run lifecycle listener failed on ${type}${runId ? ` for run ${runId}` : ''}: ${message}`);
}
