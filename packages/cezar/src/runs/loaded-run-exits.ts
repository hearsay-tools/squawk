/**
 * The store's load-time status writers (slice S4a of .ai/specs/2026-11-03-run-store-owns-exits.md,
 * Table C): each applies a run exit to a record just read off disk, so it settles what that exit
 * settles at runtime (Table B targets B10, B11). `reconcileLoadedRun` (below) runs them in order.
 */
import { engineOwnsRun } from '@open-mercato/cezar-contract/run-predicates';
import { applyExit } from './run-exits.ts';
import { restoreLostReferencedPullRequest } from './loaded-run-healing.ts';
import { stageLoaded } from './record-write-rules.ts';
import { referencedPrDeclaration, resolveReferencedRef, restoreOriginatingIssue } from './run-references.ts';
import type { RunRecord } from './store.ts';

export function settleLoadedStop(run: RunRecord): void {
  // An accepted Stop is durable intent, never an interrupted run to auto-resume. It can meet a run
  // that settled before the Stop did (the engine's own late Stop), so it takes `cancel-late`.
  if (run.stopping) Object.assign(run, applyExit(run, 'cancel-late'));
  run.stopping = undefined;
}

export function restoreLoadedUsageLimitHold(run: RunRecord): void {
  // A usage-limited run is waiting for its resume (hearsay-tools/cezarion#1236, phase 4a). Rows a
  // schema-7 Squawk wrote kept it failed with the appointment; they read as the waiting run they are.
  if (run.status === 'failed' && run.autoResumeAt !== undefined) Object.assign(run, applyExit(run, 'hold'));
}

export function failLoadedInterruptedRun(run: RunRecord, opts?: { keepLive?: boolean }): void {
  // A run that was live when the previous process exited can never finish —
  // surface that instead of a forever-"running" ghost. `review` survives
  // restarts on purpose: the gate is pure data (worktree + branch + record)
  // with no live process, so the diff panel, Send back (resume) and Draft PR
  // all still work.
  // A usage-limit hold runs no process, so no exit interrupted it: its appointment stands.
  if (!opts?.keepLive && engineOwnsRun(run)) {
    Object.assign(run, applyExit(run, 'fail-interrupted'));
  }
}

/**
 * Reconcile one record just read off disk with the fact that whichever process wrote it is gone.
 *
 * Mutates and returns `run`. Extracted from `RunStore.open` so the read-only index reader
 * (`./run-index.ts`) answers the SAME question about a `running` row on disk. Two parsers that
 * disagree here is a visible bug, not an internal one: the cockpit would show a task as running
 * in the ⌘K index and failed the moment you opened it.
 *
 * `keepLive` (#367): leave `queued`/`running`/`waiting` untouched so the caller can recover them
 * (RunManager.recover re-queues queued runs, resumes interrupted ones). Without it — one-shot CLI
 * paths that never recover, and the index reader, which has no manager at all — live-looking runs
 * are marked failed so no ghost stays behind.
 */
export function reconcileLoadedRun(run: RunRecord, opts?: { keepLive?: boolean }): RunRecord {
  settleLoadedStop(run);
  restoreLoadedUsageLimitHold(run);
  failLoadedInterruptedRun(run, opts);
  clearLoadedStaleResume(run);
  restoreLostReferencedPullRequest(run, referencedPrDeclaration, resolveReferencedRef);
  restoreOriginatingIssue(run);
  // Repository scoping follows reconciliation: stores arm a handle asynchronously, while
  // the read-only index applies its cached handle to these fresh records (#97). This ordering
  // also scopes any referenced PR restored above without filtering candidate evidence first.
  return run;
}

function clearLoadedStaleResume(run: RunRecord): void {
  // Recovery owns waits; a usage-limit appointment survives while status is waiting.
  stageLoaded(run);
}

/**
 * Settle an adopted dead owner’s live run without starting work. Untouched runs cancel; started
 * runs become interrupted. Stop explicitly cancels its target. Mutates run.
 */
export function settleOrphanedRun(run: RunRecord, opts: { stop?: boolean | undefined } = {}): RunRecord {
  if (opts.stop && (run.status === 'queued' || run.status === 'running' || run.status === 'waiting')) run.stopping = true;
  if (run.status === 'queued' && !run.startedAt && run.workflowDef !== undefined &&
    run.steps.every((step) => step.status === 'pending' && !step.startedAt && !step.sessionId)) {
    Object.assign(run, applyExit(run, 'cancel'));
  }
  return reconcileLoadedRun(run, { keepLive: false });
}
