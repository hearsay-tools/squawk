import type { WaitEngine } from './wait-engine.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import { squawkDoneRequestSchema, type SquawkDoneRequest, type SquawkDoneAnswer, type DoneErrorCode, type DoneOwedInput } from '@open-mercato/cezar-contract/waits';
import type { RunRecord } from '../../runs/store.ts';
import type { RunPatchInput } from '../../runs/ports.ts';
import type { RunLookup, RunWrites, TranscriptFactsPort } from '../../runs/ports.ts';
import { doneErrorMessage } from '../../ci-wait/errors.ts';
import { openCompletionRequests, recordRequestRefusal, type CompletionRefusal } from '../completion-policy.ts';
import type { ActiveRun } from '../active-run.ts';
import type { RunExitId, ExitCall } from '../../runs/run-exits.ts';
import { openWaitList, openWaits } from '../waits.ts';
import { toolSessionRefusal } from './squawk-tools.ts';
import { clearIdleTimer, clearAutosaveTimer } from './input-timers.ts';
import { hasPendingHumanAsk } from './pending-ask-facts.ts';
import * as completionGateReads from './completion-gate.ts';
import type { RunModuleContext, PendingContinuation } from './types.ts';
import type { RunSettlement } from './run-settlement.ts';
import { retireDoneAccepted, type TurnSettler } from './turn-settler.ts';
import { factsAtDone, owedAtDone } from './done-accepted.ts';
import type { TurnNudges } from './turn-nudges.ts';
import type { RunLine } from './run-line.ts';
import { isFamilyRecord, receiptsOf } from '../../runs/task-rights.ts';

interface RunFinishHost {
  move(id: string, exit: RunExitId, patch?: Omit<RunPatchInput, 'status'>, call?: ExitCall): RunRecord | undefined;
  dropActive(id: string): void;
  waitEngine: WaitEngine;
  reconcileWorkerWaits(id?: string): void;
  executionBlockedByRootFinish(run: RunRecord): boolean;
  hasUnansweredHumanAsk(id: string): boolean;
}

export class RunFinish {
  constructor(private readonly context: RunModuleContext, private readonly completionGateHost: completionGateReads.CompletionGateHost,
    private readonly runSettlement: RunSettlement, private readonly turnSettler: TurnSettler,
    private readonly turnNudges: TurnNudges, private readonly line: RunLine, private readonly host: RunFinishHost) {}

  /**
   * `cezar_done` (hearsay-tools/cezarion#1234). Accepted, the run records the done
   * (`doneAccepted`, hearsay-tools/squawk#2587) and finishes at the end of a turn with no new wait
   * or question, through the done branch, which cancels every open wait; in a workflow step that is
   * not the last, that branch completes the step and the next one starts
   * (hearsay-tools/cezarion#1620), and the answer says which. Input that arrives after the done is
   * delivered first, and the run finishes when that turn ends; `turn-settler.ts` retires the record.
   * Refused, the answer says what to do first, and nothing is recorded. The gate, in order: the
   * session, a root finish, the user's question, input still owed to the agent
   * (`input_pending`), then the completion gate: for a root its workers' questions, live workers
   * and uncollected results. The turn end re-checks the completion gate (`deferParentCompletion`).
   */
  acceptDone(runId: string, generation: string, request: SquawkDoneRequest, signal?: AbortSignal): SquawkDoneAnswer {
    const parsed = squawkDoneRequestSchema.parse(request);
    const state = this.completionGateHost.active.get(runId);
    const open_waits = openWaitList(this.context.store.getRun(runId)?.waits ?? []);
    const refuse = (code: DoneErrorCode, message: string, workers: { worker_id: string; reason: 'outstanding' | 'uncollected' | 'question' }[] = [], owed: DoneOwedInput[] = []): SquawkDoneAnswer => {
      // Fixed codes only, as for wait registration.
      console.warn(`[hsq] cezar_done refused: ${code}`);
      return { ok: false, code, message, ...(workers.length ? { workers: workers.slice(0, 64) } : {}), open_waits, ...(owed.length ? { owed } : {}) };
    };
    const session = toolSessionRefusal(this.context.store.getRun(runId), state, this.completionGateHost.active.get(runId), generation, signal, this.context.disposed());
    const run = this.context.store.getRun(runId);
    if (session || !run || !state?.liveSession.session) return refuse(session ?? 'run_missing', doneErrorMessage(session ?? 'run_missing'));
    if (this.host.executionBlockedByRootFinish(run)) return refuse('root_finish_pending', doneErrorMessage('root_finish_pending'));
    // The answer a continuation opened with is not a pending question while its turn runs.
    // A cezar_ask this turn registered is pending too, before its turn end shows it
    // (hearsay-tools/cezarion#2442).
    if (state.boundary.pendingHumanAsk || this.host.hasUnansweredHumanAsk(runId) || askedThisTurn(run)) return refuse('human_question_pending', doneErrorMessage('human_question_pending'));
    const owed = owedAtDone(run, state);
    if (owed.length) return refuse('input_pending', doneErrorMessage('input_pending'), [], owed);
    const refusal = this.completionRefusal(runId);
    if (refusal) {
      recordRequestRefusal(state, refusal, true);
      // A done accepted earlier in this run no longer holds: the gate refuses it now.
      retireDoneAccepted(this.context.store, runId, 'reconsidered', `completion refused: ${refusal.code}`);
      return refuse(refusal.code, refusal.message, refusal.workers);
    }
    try { recordDoneAccepted(this.context.store, this.context.store.transcriptFacts, runId, { session: generation, at: new Date().toISOString(), summary: parsed.summary }); }
    catch { return refuse('unavailable', doneErrorMessage('unavailable')); }
    const next = state.boundary.nextStep?.session === state.liveSession.session ? state.boundary.nextStep.label : undefined;
    return { ok: true, finishes: 'at_turn_end', ...(next === undefined ? { completes: 'task' as const } : { completes: 'step' as const, next_step: next }), open_waits };
  }

  completionRefusal(runId: string): CompletionRefusal | undefined { return completionGateReads.completionRefusal(this.context, this.completionGateHost, runId); }

  /** The read-only verdict and explicit Finish share this decision. Operational failures
   * (for example a failed durable write) are still handled at execution time. */
  private finishDecision(runId: string):
    { action: 'session' | 'root' | 'waiting' | 'review' } | { reason: string; warn?: boolean } { return completionGateReads.finishDecision(this.context, this.completionGateHost, runId); }

  deferParentCompletion(runId: string): boolean {
    const gate = this.completionGate(runId);
    if (gate === 'accept') return false;
    const state = this.completionGateHost.active.get(runId);
    // Mid-turn, the live turn end takes its done to the gate itself, behind owed input and waits.
    if (typeof gate === 'object' && state?.liveSession.session && state.boundary.atTurnBoundary === state.liveSession.session) {
      this.turnSettler.settleTurn(runId, state, 'gate', this.turnSettler.boundaryTurn(runId, state, state.liveSession.session, true), gate);
    }
    return true;
  }

  /** The completion gate for a root's done: `accept`; a refusal a live session takes as its turn
   *  end's (`settleTurn`); or `held` when the gate settled it itself: a stopped root, a refusal
   *  queued for a closed session, or a pending human question that parks for the user. */
  completionGate(runId: string): 'accept' | 'held' | CompletionRefusal {
    let parent = this.context.store.getRun(runId);
    if (!completionGateReads.gatesCompletion(this.context, parent)) return 'accept';
    // A late success callback has no authority to reopen a stopped/reviewing root.
    if (['done', 'review', 'failed', 'cancelled'].includes(parent.status)) return 'held';
    const state = this.completionGateHost.active.get(runId);
    const pendingAsk = this.familyQuestionPending(runId, receiptsOf(parent).length, state);
    if (!pendingAsk && this.completionMayPass(runId)) return 'accept';
    if (isFamilyRecord(parent) && parent.delegation.finishRequestedAt) {
      // Legacy accepted Finish cannot strand the new gate behind an execution ban.
      const { finishRequestedAt: _intent, ...delegation } = parent.delegation;
      this.context.store.commitDelegation([{ id: runId, delegation }]);
      parent = { ...parent, delegation };
    }
    const refusal = pendingAsk ? undefined : this.completionRefusal(runId);
    if (refusal && state?.liveSession.session?.open) return refusal;
    // A legacy accepted Finish takes the same path as a done: its refusal reopens the session.
    if (refusal) { this.turnNudges.queueCompletionRefusal(runId, refusal); return 'held'; }
    // Every blocker but the pending human question is a refusal: the question parks for the user.
    this.context.store.appendEvent(runId, { type: 'note', tone: 'warning', message: 'Completion blocked: answer the pending human question.' });
    this.host.move(runId, 'park', { finishedAt: undefined }, { stepId: state?.liveSession.currentStepId });
    this.context.store.flush();
    if (state) {
      clearIdleTimer(state);
      this.line.leavePool(runId); this.line.park(runId);
      this.line.releaseSlot();
    }
    return 'held';
  }

  /** Only a root with workers keeps its pending question through completion
   *  (hearsay-tools/cezarion#2784): every task is a root once provisioned. */
  private familyQuestionPending(runId: string, receipts: number, state: ActiveRun | undefined): boolean {
    if (receipts === 0) return false;
    return hasPendingHumanAsk(runId, id => this.completionGateHost.pendingHumanAskSeq(id)) || !!state?.boundary.pendingHumanAsk;
  }

  /** Human Finish keeps the worker guarantees and bypasses request obligations only. */
  private completionMayPass(runId: string): boolean { return completionGateReads.completionMayPass(this.context, this.completionGateHost, runId); }

  /** Finish can arrive during continuation preflight. Retain its accepted
   * payload in the ordinary queue, releasing the slot without opening a session. */
  holdContinuationForRootFinish(runId: string, continuation: PendingContinuation, state?: ActiveRun): boolean {
    const run = this.context.store.getRun(runId);
    if (!run || !this.host.executionBlockedByRootFinish(run)) return false;
    this.line.enqueueContinuation(runId, continuation, true);
    this.context.store.updateStep(runId, continuation.stepId, { status: 'pending' });
    this.host.move(runId, 'requeue');
    if (state) clearAutosaveTimer(state);
    this.line.unmarkStarting(runId); this.host.dropActive(runId);
    return true;
  }

  async settleRequestedRootFinish(runId: string): Promise<void> {
    return this.context.work.track('settleRequestedRootFinish', this.settleRequestedRootFinishWork(runId));
  }

  private async settleRequestedRootFinishWork(runId: string): Promise<void> {
    try {
      const status = this.context.store.getRun(runId)?.status;
      if (status === 'review') { this.finish(runId); return; }
      if (status === 'running') this.host.move(runId, 'park');
      this.host.reconcileWorkerWaits(runId);
      await this.runSettlement.settleSuccess(runId, true);
    }
    catch { console.warn(`[hsq] parent finish checkpoint failed; intent retained for retry`); }
  }

  /** Close the open session gracefully — the run then completes as `done`
   *  (or rests at `review` when the worktree holds changes, spec 009).
   *  On a run already resting at `review` (no session — the engine loop is
   *  over), "Finish" is the third review exit: accept the changes without a
   *  PR and flip straight to `done`. */
  finish(runId: string): boolean {
    const decision = this.finishDecision(runId);
    if ('reason' in decision) {
      if (decision.warn) this.context.store.appendEvent(runId, { type: 'note', tone: 'warning', message: decision.reason });
      return false;
    }
    const state = this.completionGateHost.active.get(runId);
    if (decision.action === 'session' && state?.liveSession.session) {
      try {
        this.host.waitEngine.cancelAll(runId);
        this.acceptRootRequestFinish(runId);
      } catch { return false; }
      this.closeQuestionOnFinish(runId);
      state.liveSession.requestFinish();
      clearIdleTimer(state);
      this.context.store.appendEvent(runId, { type: 'lifecycle', message: 'session closed by user' });
      state.liveSession.session.end();
      return true;
    }
    const run = this.context.store.getRun(runId);
    if (decision.action === 'root') {
      try { this.context.store.commitRootFinishIntent(runId); this.host.reconcileWorkerWaits(runId); }
      catch { return false; }
      // A root without workers may Finish with a question pending (hearsay-tools/cezarion#2784):
      // close it first, so the completion gate does not park the task on it again.
      this.closeQuestionOnFinish(runId);
      void this.settleRequestedRootFinish(runId);
      return true;
    }
    if (decision.action === 'waiting' && run) {
      this.closeQuestionOnFinish(runId);
      const finishedAt = new Date().toISOString();
      for (const step of run.steps) {
        if (step.status === 'waiting' || step.status === 'running') {
          this.context.store.updateStep(runId, step.id, { status: 'done', finishedAt });
        }
      }
      void this.runSettlement.settleSuccess(runId);
      return true;
    }
    if (decision.action === 'review') {
      try { this.acceptRootRequestFinish(runId); } catch { return false; }
      this.closeQuestionOnFinish(runId);
      this.host.move(runId, 'accept-review');
      this.context.store.appendEvent(runId, { type: 'lifecycle', message: 'review accepted — finished without a PR' });
      return true;
    }
    return false;
  }

  /** Persist the human's authority before settling obligations or closing a live session. */
  private acceptRootRequestFinish(runId: string): void {
    const run = this.context.store.getRun(runId);
    if (!isFamilyRecord(run) || !openCompletionRequests(this.context.store, runId).sent.length) return;
    this.context.store.commitDelegation([{ id: runId, delegation: { ...run.delegation, finishRequestedAt: new Date().toISOString() } }]);
    this.host.reconcileWorkerWaits(runId);
  }

  /** Finish ends the task, so an unanswered question is closed rather than left answerable on a
   * finished run (hearsay-tools/cezarion#1260). A root with workers never gets here with one pending:
   * its Finish is refused until the question is answered. Stop keeps the question, which a human may still
   * answer to reopen the run (open-mercato/cezar#505). */
  private closeQuestionOnFinish(runId: string): void {
    const askSeq = this.completionGateHost.pendingHumanAskSeq(runId);
    if (askSeq !== undefined) this.context.store.appendEvent(runId, { type: 'human-ask-closed', askSeq, reason: 'finish' });
  }
}

/** The only writer of `doneAccepted` (ADR 0064): an accepted `cezar_done`, committed before the
 *  tool answers, so a restart still finishes the run on it. The last event, the waits and the last
 *  agent input then (`factsAtDone`) order what is new to the done. A done that replaces one still on record keeps its spent
 *  free turn, so calling done again earns no second free delivery. */
function recordDoneAccepted(store: RunWrites & RunLookup, facts: TranscriptFactsPort, runId: string, done: { session: string; at: string; summary?: string | undefined }): void {
  const run = store.getRun(runId);
  if (!run) return;
  store.commitOutcome(runId, { kind: 'done-accepted', done: { session: done.session, at: done.at, seq: facts.transcriptFacts(runId).lastSeq, ...factsAtDone(run),
    ...(done.summary === undefined ? {} : { summary: done.summary }), ...(run.doneAccepted?.freeTurn ? { freeTurn: true as const } : {}) } });
}

/** An agent question registered in this turn: open, and not yet shown (no `askSeq`). */
function askedThisTurn(run: RunRecord): boolean {
  return WAIT_KINDS.human.select(openWaits(run)).some(wait => wait.source !== 'cezar' && wait.askSeq === undefined);
}
