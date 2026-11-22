import type { WaitEngine } from './wait-engine.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import { holdsOwedResults } from '../waits.ts';
import { runsAwaitingPeer } from '../wait-scope.ts';
import type { RunModuleContext } from './types.ts';
import type { ActiveRun } from '../active-run.ts';
import type { CommitSource, RunRecord } from '../../runs/store.ts';
import type { WorkerWaitEntry } from '@open-mercato/cezar-contract/waits';
import { historyDeletionPending, executionBlockedByRootFinish } from './run-guards.ts';
import { repairFailedRootFinish } from '../completion-policy.ts';
import { reconcileConversationState, projectConversationEvents, settledRunFamilies } from '../../delegation/conversations.ts';
import { reconcileWorkerEntry } from '../../delegation/wait.ts';
import { workerOutcome } from '../../runs/delegation-state.ts';
import { workerOutcomeKey } from '../../runs/transcript-facts.ts';
import { LivenessTimers } from './liveness-timers.ts';
import { familyWorkers, isLiveWorker, supervisedWorkers } from '../../runs/supervised.ts';
import { familyRecordOf, isFamilyRecord, receiptsOf } from '../../runs/task-rights.ts';

interface FamilyReconcilerHost {
  reapTerminalScratch(id: string): void;
  waitEngine: WaitEngine;
  active(id: string): ActiveRun | undefined;
  isActive(id: string): boolean;
  recoveringRun(run: RunRecord | string | undefined): boolean;
  cancel(id: string): void;
  retireSettledQuestions(id: string): void;
  closeRoutedQuestions(id: string): void;
  reconcileWorkerWaits(id?: string): void;
}

type WorkerObservations = ReturnType<FamilyReconciler['workerObservations']>;

export class FamilyReconciler {
  readonly onDelegationRun = (run: RunRecord, source?: CommitSource): void => {
    // Delegation metadata checkpoints do not change task status.
    // A republish changed nothing durable: there is nothing to reap, cancel or reconcile.
    if (source === 'live-release') return;
    // Restart recovery fails an interrupted turn just before it continues the task, so a reap
    // waits until recovery ends and then reads the run again (hearsay-tools/squawk#3909).
    if (!this.context.disposed() && source === undefined) {
      if (this.host.recoveringRun(run)) this.deferredReaps.add(run.id);
      else this.host.reapTerminalScratch(run.id);
    }
    if (!this.context.disposed() && !['queued', 'running', 'waiting'].includes(run.status) && !holdsOwedResults(run)) this.host.waitEngine.cancelAll(run.id);
    if (run.delegation && !['queued', 'running', 'waiting'].includes(run.status)) this.host.active(run.id)?.liveSession.revokeDelegation?.();
    if (this.context.disposed() || this.host.recoveringRun(run)) return;
    // A destroy retry changes nothing the family reconcile reads (#880).
    if (source === 'delegation-destroy-progress') return;
    if (run.delegation && run.delegation.role !== 'invalid' && !['queued', 'running', 'waiting'].includes(run.status)) {
      for (const id of settledRunFamilies(this.context.store, run)) this.host.reconcileWorkerWaits(id);
    }
    this.host.waitEngine.resolvePeerWaits(runsAwaitingPeer(run, () => this.context.store.listRuns())); // never in recovery: an interrupted peer fails, then continues
  };

  /** Runs whose scratch reap waits for the recovery that holds them. */
  private readonly deferredReaps = new Set<string>();
  /** After recovery: reap the scratch of each held run that recovery left terminal. */
  reapDeferredScratch(): void {
    for (const id of [...this.deferredReaps]) {
      if (this.host.recoveringRun(id)) continue;
      this.deferredReaps.delete(id);
      if (!this.context.disposed()) this.host.reapTerminalScratch(id);
    }
  }

  private reconcilingWorkers = false;
  private reconcilingFamily: string | undefined;
  /** Family roots queued behind the reconcile pass in flight. Kept here: the pass drains it, and
   *  it names families, not one run's memory. */
  private readonly pendingReconciliations = new Set<string | undefined>();
  recoveryFactsPending = false;
  constructor(private readonly context: RunModuleContext, private readonly host: FamilyReconcilerHost,
    private readonly timers = new LivenessTimers()) {}
  setRecoveryFactsPending(value: boolean): void { this.recoveryFactsPending = value; }
  dispose(): void {
    this.timers.clearKind('request-deadline');
  }

  /** A turn of this run is executing now: a recovered run's is not, whatever it last recorded. */
  private isExecutingWorkerWaitTurn(runId: string): boolean {
    const state = this.host.active(runId);
    return !!state?.liveSession.session?.open && !state.liveSession.cancelled && !this.host.recoveringRun(runId) && state.boundary.atTurnBoundary !== state.liveSession.session;
  }

  /** Each root's earliest request deadline is one `request-deadline` bound, never a polling loop. */
  private reconcileConversations(family: readonly RunRecord[]): void {
    const now = new Date().toISOString();
    for (const root of family) {
      if (root.delegation?.role !== 'root' || !root.delegation.conversation) continue;
      const next = reconcileConversationState(root, (id) => this.context.store.getRun(id), now, run =>
        run.delegation?.role === 'worker' ? this.context.store.workerExecutions.readWorkerExecution(run.id)?.phase === 'complete' : !this.host.isActive(run.id), id => this.context.store.isUnreadable(id));
      if (next && next !== root.delegation.conversation) this.context.store.commitConversation(root.id, next);
      projectConversationEvents(this.context.store, this.context.store.getRun(root.id)!);
      this.host.retireSettledQuestions(root.id);
      this.timers.clear('request-deadline', root.id);
      const deadlines = next?.messages.filter(message => message.kind === 'request' && message.deadline &&
        !next.outcomes.some(outcome => outcome.requestId === message.id)).map(message => Date.parse(message.deadline!)) ?? [];
      if (deadlines.length) {
        const arm = (delay: number) => {
          this.timers.arm({ kind: 'request-deadline', runId: root.id, delayMs: delay }, () => {
            // This root's own family by name: it may have no live member left by its deadline
            // (#779), which the pass over live families would skip.
            try { this.host.reconcileWorkerWaits(root.id); this.host.reconcileWorkerWaits(); }
            catch {
              // A failed disk checkpoint retains the obligation; a bounded retry follows the
              // same failure policy as worker wait deadlines, never drops an unhandled error.
              if (!this.context.disposed()) arm(1_000);
            }
          });
        };
        arm(Math.max(0, Math.min(...deadlines) - Date.now()));
      }
    }
  }

  /** One delegation family: its root, then every worker whose receipt the root holds (the store's
   *  `parent_run_id` query). A worker a worker started is filed under the root too, so this never recurses. */
  familyMembers(rootId: string): RunRecord[] {
    const root = this.context.store.getRun(rootId);
    return [...(root ? [root] : []), ...this.context.store.listWorkersOf(rootId)];
  }

  /** Every member of every family with a live member, each once: the families the store holds
   *  in memory (#779), which is where every delegation sweep that is not about one family looks. */
  liveFamilyMembers(): RunRecord[] {
    const roots = new Set<string>();
    for (const run of this.context.store.listRuns()) {
      if (run.delegation?.role === 'root') roots.add(run.id);
      else if (run.delegation?.role === 'worker') roots.add(run.delegation.parentRunId);
    }
    return [...roots].flatMap(rootId => this.familyMembers(rootId));
  }

  /**
   * Recovery's full pass (#661): every family whose root carries a conversation — settled ones
   * too, so a projection or outcome a crash interrupted is repaired — then every live family.
   * Only roots with a conversation are read; a settled family without one has nothing to settle:
   * the other repair the sweep makes on a finished member (a cancelled root's Finish
   * intent) is a clause of `isLiveRecord`, so open already holds that family.
   * Everything else asks `reconcileWorkerWaits()`, which covers the live families (#779).
   */
  async reconcileRecoveryWorkerFamilies(): Promise<void> {
    for (const rootId of this.context.store.listConversationRootIds()) {
      if (this.context.store.claims.writeRefusal(rootId)) continue;
      this.recoveryFactsPending = true;
      await this.context.store.transcriptFacts.prepareRecoveryFacts(rootId);
      if (this.context.disposed()) return;
      this.recoveryFactsPending = false;
      this.host.reconcileWorkerWaits(rootId);
    }
  }

  /** Authority and wait live on disk; these collections are admission/timer caches only. One
   *  family by its root's id, or (no id) every family with a live member. */
  reconcileWorkerWaits(familyRootId?: string): void {
    if (this.context.disposed()) return;
    if (this.reconcilingWorkers) {
      // The current pass already observes its own writes. A different family
      // (or an explicit global pass) must not disappear behind the recursion guard.
      if (this.reconcilingFamily !== undefined && this.reconcilingFamily !== familyRootId) {
        this.pendingReconciliations.add(familyRootId);
      }
      return;
    }
    this.pendingReconciliations.add(familyRootId);
    for (const pending of this.pendingReconciliations) {
      this.pendingReconciliations.delete(pending);
      if (this.context.disposed()) break;
      this.reconcileWorkerFamily(pending);
    }
  }

  /** One pass reads each cold run once (hearsay-tools/cezarion#2378): a family's conversation
   *  names its sender and recipient on every message. */
  private reconcileWorkerFamily(familyRootId?: string): void {
    // As the global pass: a family this store may not write (foreign, fallback) is not repaired here.
    if (familyRootId !== undefined && this.context.store.claims.writeRefusal(familyRootId)) return;
    this.context.store.withReadCache(() => this.reconcileFamilyPass(familyRootId));
  }

  private reconcileFamilyPass(familyRootId?: string): void {
    this.reconcilingWorkers = true;
    this.reconcilingFamily = familyRootId;
    try {
      // One family by name, or every family with a live member (#779): a family nobody in it is
      // live has nothing left to settle, and its members are no longer in memory.
      const family = (familyRootId === undefined ? this.liveFamilyMembers() : this.familyMembers(familyRootId))
        .filter(run => !this.recoveryFactsPending || !this.host.recoveringRun(run));
      this.reconcileConversations(family);
      for (const parent of family) {
        if (!parent.delegation || parent.delegation.role === 'invalid' || historyDeletionPending(this.context.store, parent.id)) continue;
        repairFailedRootFinish(this.context.store, parent);
        if (parent.status === 'cancelled' && parent.delegation.role === 'root' && parent.delegation.finishRequestedAt) {
          this.context.store.move(parent.id, 'cancel-root');
        }
        if (this.endStoppedParent(parent)) continue;
        if (executionBlockedByRootFinish(this.context.store, parent)) continue;
        const observed = (now: string) => this.workerObservations(parent, now);
        this.reconcileWorkerEntries(parent, observed);
      }
    } finally { this.reconcilingWorkers = false; this.reconcilingFamily = undefined; }
  }

  /**
   * A parent that can no longer answer ends what its workers wait on it for
   * (hearsay-tools/cezarion#2410). A parent being stopped closes their questions now, however long its
   * stop takes. A settled one also cancels its worker waits, which lets a stored wait upgraded onto a
   * finished root go (hearsay-tools/cezarion#1301), and its live workers. A failed root keeps the
   * family's live workers (hearsay-tools/squawk#3337): they run to their own end, and the root
   * collects them after a Continue. A settled worker, failed or not, cancels the live workers it
   * started: they work in its directory. A recovering parent is left to recovery. True when the
   * parent is settled, so the pass skips the rest.
   */
  private endStoppedParent(parent: RunRecord): boolean {
    const recovering = this.host.recoveringRun(parent);
    if (parent.stopping && parent.delegation?.role === 'root' && !recovering) this.host.closeRoutedQuestions(parent.id);
    if (['queued', 'running', 'waiting'].includes(parent.status)) return false;
    if (recovering) return true;
    const stale = WAIT_KINDS.worker.select(parent.waits ?? []).filter(wait => wait.phase === 'open' || wait.phase === 'resolved').map(wait => wait.id);
    if (stale.length) this.host.waitEngine.cancel(parent.id, stale);
    this.host.closeRoutedQuestions(parent.id);
    for (const child of this.endedWith(parent)) this.host.cancel(child.id);
    return true;
  }

  /** The live workers a settled parent ends: the whole family of a root that did not fail, and
   *  the workers a settled worker started. */
  private endedWith(parent: RunRecord): RunRecord[] {
    const workers = isFamilyRecord(parent)
      ? (parent.status === 'failed' ? [] : familyWorkers(this.context.store, parent))
      : supervisedWorkers(this.context.store, parent);
    return workers.filter(isLiveWorker);
  }

  /** The settled outcomes a run's worker waits can observe now: each worker of its family whose
   *  execution is provably complete, and each deleted worker's retained result. A wait names the
   *  workers it reads, and registration checked that the run may wait on each. */
  private workerObservations(parent: RunRecord, now: string) {
    const family = familyRecordOf(parent, id => this.context.store.getRun(id));
    const outcomes = familyWorkers(this.context.store, parent).flatMap(child => {
      const outcome = workerOutcome(child, now);
      return outcome && this.context.store.workerExecutions.readWorkerExecution(child.id)?.phase === 'complete' ? [outcome] : [];
    });
    // Explicit history deletion replaces the live execution proof with a completed
    // parent receipt. Keep its acknowledged outcome while other all-wait workers run.
    const deletedResults = new Map(receiptsOf(family).flatMap(receipt => {
      const result = this.context.store.workerResults.readDeletedWorkerResult(family!.id, receipt.workerId);
      return result ? [[receipt.workerId, result] as const] : [];
    }));
    for (const result of deletedResults.values()) {
      if (result.status === 'review' || result.status === 'done' || result.status === 'failed' || result.status === 'cancelled') {
        outcomes.push({ workerId: result.workerId, revision: result.revision, status: result.status, observedAt: result.observedAt,
          ...(result.error ? { summary: result.error } : {}) });
      }
    }
    return { outcomes, deletedResults };
  }

  /** The family conversation's request outcomes, which settle request waits. */
  private requestOutcomesOf(run: RunRecord) {
    const root = run.delegation?.role === 'root' ? run : run.delegation?.role === 'worker' ? this.context.store.getRun(run.delegation.parentRunId) : undefined;
    return root?.delegation?.role === 'root' ? root.delegation.conversation?.outcomes ?? [] : [];
  }

  /**
   * Reconcile a run's open `worker` entries (hearsay-tools/cezarion#1235): the same observation
   * rules as the old engine's wait had (an unsettled wait follows a re-run worker's revision; an
   * observation without current proof is dropped). A satisfied or overdue entry resolves through
   * `resolveWait`, unless every worker it names was destroyed while the turn that waits on them is
   * still executing: nothing is left to await, so it is cancelled. Any other entry has its deadline
   * armed. Messages never resolve one.
   */
  private reconcileWorkerEntries(parent: RunRecord, observe: (now: string) => WorkerObservations): void {
    const entries = WAIT_KINDS.worker.select(parent.waits ?? []);
    if (!entries.length) return;
    const now = new Date().toISOString();
    const { outcomes, deletedResults } = observe(now);
    const requests = this.requestOutcomesOf(parent);
    const destroyed = (entry: WorkerWaitEntry) => !!entry.workerIds?.length && this.isExecutingWorkerWaitTurn(parent.id) && entry.workerIds.every(id => {
      const child = this.context.store.getRun(id)?.delegation;
      return child?.role === 'worker' ? child.destroy?.phase === 'complete' : deletedResults.get(id)?.cleanup === 'complete';
    });
    // A result still owed for workers the executing turn has since destroyed is no longer news.
    const retired = entries.filter(entry => entry.phase === 'resolved' && destroyed(entry)).map(entry => entry.id);
    if (retired.length) this.host.waitEngine.cancel(parent.id, retired);
    for (const entry of entries.filter(wait => wait.phase === 'open')) {
      let selected = entry;
      if (entry.workerIds) {
        const revisions = entry.workerIds.map(workerId => {
          const metadata = this.context.store.getRun(workerId)?.delegation;
          return { workerId, revision: metadata?.role === 'worker' ? metadata.executionRevision ?? 0 : deletedResults.get(workerId)?.revision ?? 0 };
        });
        if (JSON.stringify(entry.revisions) !== JSON.stringify(revisions)) selected = { ...selected, revisions };
        const proven = (selected.outcomes ?? []).filter(previous => outcomes.some(current =>
          current.workerId === previous.workerId && (current.revision ?? 0) === (previous.revision ?? 0)));
        if (proven.length !== (selected.outcomes ?? []).length) selected = { ...selected, outcomes: proven };
      }
      const { entry: next, reason } = reconcileWorkerEntry(selected, outcomes, now, requests);
      if (reason && destroyed(next)) {
        this.host.waitEngine.cancel(parent.id, [entry.id]);
      } else if (reason) {
        if (!this.host.waitEngine.resolveWorkerWait(parent.id, entry, { ...next, result: { reason } })) continue;
      } else {
        this.host.waitEngine.refresh(parent.id, entry, next);
      }
      const recorded = this.context.store.transcriptFacts.transcriptFacts(parent.id).workerOutcomeKeys;
      for (const outcome of next.outcomes ?? []) {
        if (!recorded.includes(workerOutcomeKey(entry.id, outcome.workerId, outcome.revision ?? 0))) {
          this.context.store.eventLog.appendEvent(parent.id, { type: 'worker-outcome', waitId: entry.id, outcome });
        }
      }
    }
  }

}
