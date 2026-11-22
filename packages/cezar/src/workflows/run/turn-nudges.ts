import { transitionTurnBoundary } from './turn-boundary.ts';
import { randomUUID } from 'node:crypto';
import type { AgentInput } from '@open-mercato/cezar-contract/agent-input';
import type { ContentBlock } from '../../core/agent-runner.ts';
import type { AgentSession } from '../../core/agent-runner.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { RunEventInput, RunPatchInput } from '../../runs/ports.ts';
import { enqueueAgentInput, hasLiveInboxClaim } from '../../delegation/input.ts';
import { recordRequestRefusal, type CompletionRefusal } from '../completion-policy.ts';
import { NO_WAIT_NUDGE_NOTE, NO_WAIT_NO_REPLY_NOTE, COMPLETION_NO_REPLY_NOTE, COMPLETION_NUDGE_NOTE, AUTONOMOUS_NUDGE, AUTONOMOUS_NO_ACK_NOTE, AUTONOMOUS_NO_REPLY_NOTE, stepScopedNudge, type TurnEndOutcome } from '../turn-end.ts';
import type { ActiveRun } from '../active-run.ts';
import type { RunExitId } from '../../runs/run-exits.ts';
import { clearIdleTimer, clearNoWaitNudgeReplyTimer, harnessOwesInput } from './input-timers.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import * as completionGateReads from './completion-gate.ts';
import type { HumanWaits } from './human-waits.ts';
import type { RunLine } from './run-line.ts';
import type { RunModuleContext } from './types.ts';
import { LivenessTimers } from './liveness-timers.ts';
import type { Nudge } from './turn-boundary.ts';

/** Record how far the nudge Squawk just sent or tried at a turn end of the live session got. This
 *  module is the nudge fact's only writer (hearsay-tools/squawk#2452). */
function recordNudge(state: ActiveRun, nudge: Omit<Nudge, 'session'>): void {
  transitionTurnBoundary(state, { kind: 'nudge-fact', phase: 'record', session: state.liveSession.session, nudge });
}

/** Retire the nudge fact: a new turn, a submitted input, a question or a readiness retry supersedes
 *  the nudge. */
export function retireNudge(state: ActiveRun): void {
  transitionTurnBoundary(state, { kind: 'nudge-fact', phase: 'retire', session: state.liveSession.session });
}

/** The autonomous nudge `session` refused at its turn end, which waits for input readiness at that
 *  boundary, bounded by the idle timer. */
export function nudgeRefusedAt(state: ActiveRun, session: AgentSession | undefined): boolean {
  const nudge = state.boundary.nudge;
  return !!session && nudge?.session === session && nudge.state === 'refused';
}

/** The autonomous nudge `session` submitted and the harness has not acknowledged yet. Its
 *  acknowledgement bound runs while no turn does (hearsay-tools/squawk#2443). */
export function nudgeAwaitsAcknowledgement(state: ActiveRun, session: AgentSession | undefined): boolean {
  const nudge = state.boundary.nudge;
  return !!session && nudge?.session === session && nudge.cause === 'autonomous' && nudge.state === 'submitted';
}

/** The autonomous nudge `session` acknowledged, with no turn start since: its answer bound runs
 *  (hearsay-tools/squawk#3741). A turn start retires the fact. */
export function nudgeAwaitsAnswer(state: ActiveRun, session: AgentSession | undefined): boolean {
  const nudge = state.boundary.nudge;
  return !!session && nudge?.session === session && nudge.cause === 'autonomous' && nudge.state === 'acknowledged' && !nudge.answered;
}

/** A run an autonomous nudge kept running: refused, submitted and never acknowledged, or
 *  acknowledged and never answered. Its idle close settles it `waiting`. */
export function nudgeHeldRunning(state: ActiveRun): boolean {
  const session = state.boundary.nudge?.session;
  return state.boundary.nudge?.state === 'refused' || nudgeAwaitsAcknowledgement(state, session) || nudgeAwaitsAnswer(state, session);
}

/** The work the no-progress guard counts as the model working (`MODEL_PROGRESS` in
 *  `core/managed-session.ts`), with the UI frames that carry it: a turn start and a top-level item.
 *  Heartbeats, usage, a nested subagent's items and a late display update are not. */
function isModelActivity(event: NudgeEvent): boolean {
  if (['turn.started', 'text', 'tool-call', 'tool-result', 'image'].includes(event.type)) return true;
  return event.type.startsWith('item.') && event.item?.parentItemId === undefined && event.late !== true;
}
type NudgeEvent = { type: string; item?: { parentItemId?: string }; late?: true };

interface TurnNudgesHost {
  active: Map<string, ActiveRun>;
  move(id: string, exit: RunExitId, patch: Omit<RunPatchInput, 'status'>): RunRecord | undefined;
  workerExecutionStopped(id: string): boolean;
  executionBlockedByRootFinish(run: RunRecord): boolean;
  countAutomaticWakes(id: string): number;
  hasQueuedAgentInputs(id: string): boolean;
  submitAgentInput(id: string, state: ActiveRun, content: ContentBlock[]): boolean;
  resumeParkedRun(id: string, state: ActiveRun): void;
  chargeAutomaticWake(id: string): number;
  retryWaitAdmission(id: string): void;
  armIdleTimer(id: string, state: ActiveRun): void;
  /** `TurnSettler.closeIdleSession`: the idle path's close. */
  closeIdleSession(id: string, state: ActiveRun, event: RunEventInput): void;
  /** `InputDelivery.abandonNudgeFlight`: drop the nudge's flight before its session closes. */
  abandonNudgeFlight(state: ActiveRun, session: AgentSession): void;
  openTurnEndHumanWait(id: string, state: ActiveRun, step: string | undefined, via: 'no-wait' | 'budget', note: string): void;
  settledTurnOutcome(id: string, entry: 'turn-end' | 'ack' | 'ready' | 'gate' | 'reply-timer', outcome: TurnEndOutcome): TurnEndOutcome | undefined;
  queueWaitWake(id: string): void;
}

/** Decide a closed-session refusal without reading past the first matching guard. */
export function completionRefusalQueueDecision(runId: string, reads: {
  holdsAgentWaits(id: string): boolean;
  owesCompletionRefusal(id: string): boolean;
  countAutomaticWakes(id: string): number;
}, maxAutoContinues: number): 'held' | 'owed' | 'budget' | 'enqueue' {
  if (reads.holdsAgentWaits(runId)) return 'held';
  if (reads.owesCompletionRefusal(runId)) return 'owed';
  if (reads.countAutomaticWakes(runId) >= maxAutoContinues) return 'budget';
  return 'enqueue';
}

export class TurnNudges {
  constructor(private readonly context: RunModuleContext, private readonly humanWaits: HumanWaits,
    private readonly line: RunLine, private readonly completionGateHost: completionGateReads.CompletionGateHost,
    private readonly host: TurnNudgesHost, private readonly maxAutoContinues: number, private readonly completionWillWait: string,
    /** Quiet window after a final-message nudge before a still-silent session parks (#544). */
    public noWaitNudgeReplyMs: number, private readonly timers = new LivenessTimers()) {}
  /** The session just took a refusal nudge, live or queued (hearsay-tools/cezarion#1301): its turn is
   *  the nudge's, and its reply is bounded by the no-wait nudge's reply timer, so a harness that
   *  reads the refusal and says nothing parks on Squawk's human wait instead of holding the slot. */
  awaitCompletionNudgeReply(runId: string, state: ActiveRun, session: AgentSession): void {
    transitionTurnBoundary(state, { kind: 'completion-refusal', phase: 'nudge-delivered', session });
    recordNudge(state, { cause: 'completion', state: 'submitted' });
    const refusal = completionGateReads.completionRefusal(this.context, this.completionGateHost, runId);
    if (refusal) recordRequestRefusal(state, refusal);
    transitionTurnBoundary(state, { kind: 'completion-refusal', phase: 'reset-content', session: state.liveSession.session });
    clearIdleTimer(state);
    this.armNoWaitNudgeReplyTimer(runId, state);
  }

  /**
   * A blocked done found when the session is gone (`settleSuccess` after its async work, a
   * restart; hearsay-tools/cezarion#1301): the refusal is queued as one lifecycle input, charged as
   * the live nudge is, and the scheduler continuation reopens the session to deliver it
   * (`queueWaitWake`); its delivery marks that turn as the nudge's. Open waits come first: they wake
   * the run, and the refusal is a note. A spent budget opens Squawk's `budget` human wait, and an
   * input the full inbox refuses leaves the run waiting for the user. Always true.
   */
  queueCompletionRefusal(runId: string, refusal: CompletionRefusal): boolean {
    const state = this.host.active.get(runId);
    this.context.store.eventLog.appendEvent(runId, { type: 'note', tone: 'warning', message: `Completion blocked: ${refusal.message}` });
    this.host.move(runId, 'park', { finishedAt: undefined });
    this.context.store.persistence.flush();
    const decision = completionRefusalQueueDecision(runId, {
      holdsAgentWaits: id => this.humanWaits.holdsAgentWaits(id),
      owesCompletionRefusal: id => completionGateReads.owesCompletionRefusal(this.context, this.completionGateHost, id),
      countAutomaticWakes: id => this.host.countAutomaticWakes(id),
    }, this.maxAutoContinues);
    if (decision === 'held') return true;
    // One refusal owed at a time: the copy already queued reopens the run (hearsay-tools/cezarion#1301).
    if (decision === 'owed') {
      try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
      return true;
    }
    if (decision === 'budget') {
      this.humanWaits.surfaceHumanWait(runId, state, this.humanWaits.openHumanAlias(runId, state, 'budget'));
      return true;
    }
    const text = refusal.liveWorkerIds.length ? `${refusal.message} ${this.completionWillWait}` : refusal.message;
    // Its purpose is on the persisted input, so a Continue after a failed run and a restart still
    // deliver it as the nudge (hearsay-tools/cezarion#1301).
    const input: AgentInput = { id: randomUUID(), parentRunId: runId, source: 'lifecycle', purpose: 'completion-refusal', text, createdAt: new Date().toISOString() };
    // The refusal is queued with its charge (hearsay-tools/cezarion#1805): no restart delivers it uncharged.
    const spent = (this.context.store.getRun(runId)?.automaticWakes ?? 0) + 1;
    try {
      enqueueAgentInput(this.context.store.getRun(runId)!, input);
      this.context.store.commitOutcome(runId, { kind: 'charged', automaticWakes: spent }, { enqueue: [input] });
    } catch (error) {
      console.warn(`[hsq] completion refusal not queued: ${error instanceof Error ? error.message : String(error)}`);
      return true;
    }
    this.context.store.eventLog.appendEvent(runId, { type: 'agent-input', input });
    this.context.store.eventLog.appendEvent(runId, { type: 'note', message: `${COMPLETION_NUDGE_NOTE} (${spent}/${this.maxAutoContinues}): ${refusal.code}` });
    try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
    return true;
  }

  /** Stop discards a refusal the run still owes, as it discards its waits: a later Continue must not
   *  deliver a stale one (hearsay-tools/cezarion#1301). One an inbox read holds is left to it. */
  retireCompletionRefusal(runId: string): boolean {
    const inputs = this.context.store.getRun(runId)?.agentInputs ?? [];
    const kept = inputs.filter(input => input.deliveredAt || input.purpose !== 'completion-refusal' || hasLiveInboxClaim(input));
    if (kept.length === inputs.length) return false;
    try { this.context.store.commitAgentInputs(runId, kept); }
    catch (error) {
      console.warn(`[hsq] completion refusal not retired: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    return true;
  }

  /** Shared stop/input/liveness guards for an automatic continuation. */
  canAutoContinue(runId: string, state: ActiveRun): boolean {
    const run = this.context.store.getRun(runId);
    return !!run && !this.context.disposed() && !run.stopping && !state.liveSession.cancelled && !state.liveSession.finishRequested &&
      !state.inputState.agentInputError && !state.boundary.pendingHumanAsk && !hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store.transcriptFacts, id)) && !!state.liveSession.session?.open &&
      !this.host.workerExecutionStopped(runId) && !this.host.executionBlockedByRootFinish(run) && !run.waits?.length &&
      !state.inputState.agentInputFlight && !harnessOwesInput(state) && !this.host.hasQueuedAgentInputs(runId);
  }

  /**
   * Both turn-end paths keep a nudged session running, with no user-wait timer or
   * released slot. The next turn can finish with DONE, nudge again, or park at the
   * cap (waiting/monitoring with their existing wake/idle rules). Queued/accepted
   * input, worker/CI waits and parent completion keep priority. Cancel, Finish,
   * disposal and memory pause stop nudging; provider errors/exits use normal
   * teardown. Native mid-turn asks still park for an answer (outside this policy).
   * A refused ordinary nudge waits for readiness at this exact boundary; the idle
   * timeout bounds a missing readiness signal. New activity/input invalidates it.
   * `text` is the turn-end rule's nudge, scoped to the step by default (hearsay-tools/cezarion#1620).
   */
  tryAutonomousNudge(runId: string, state: ActiveRun, stepId: string,
    text = stepScopedNudge(AUTONOMOUS_NUDGE, !!state.liveSession.session && state.boundary.nextStep?.session === state.liveSession.session)): boolean {
    const session = state.liveSession.session;
    if (!state.boundary.autonomous || !session || !this.canAutoContinue(runId, state)) return false;
    retireNudge(state);
    clearIdleTimer(state);
    // One budget with the timer wakes (hearsay-tools/cezarion#1234).
    if (this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) {
      this.context.store.eventLog.appendEvent(runId, { type: 'note', stepId, message: `autonomous — safety cap reached (${this.maxAutoContinues}); automatic continuation paused` });
      return false;
    }
    const content: ContentBlock[] = [{ type: 'text', text }];
    // The fact and its bound exist before the transport can emit an event for this send: a runner
    // that starts the nudge's turn inside sendAgentMessage (OpenCode) finds them
    // (hearsay-tools/squawk#2443). A refused send takes them back.
    recordNudge(state, { cause: 'autonomous', state: 'submitted' });
    this.armAutonomousNudgeBound(runId, state);
    // The nudge keeps #505's acknowledged agent-input failure semantics.
    if (!this.host.submitAgentInput(runId, state, content)) {
      this.timers.clear('acknowledgement', runId);
      // Keep this exact boundary running until onAgentInputReady retries, without charging
      // the cap or claiming delivery. Missing readiness closes via the idle bound.
      if (session.open && !state.inputState.agentInputError && !state.liveSession.agentSessionError) {
        recordNudge(state, { cause: 'autonomous', state: 'refused' });
        this.host.armIdleTimer(runId, state);
      } else retireNudge(state);
      return false;
    }
    const spent = this.host.chargeAutomaticWake(runId);
    this.context.store.eventLog.appendEvent(runId, {
      type: 'note', stepId,
      message: `autonomous — continuing without pausing (${spent}/${this.maxAutoContinues})`,
    });
    return true;
  }

  /**
   * The bound of an autonomous nudge the harness has not acknowledged (hearsay-tools/squawk#2443),
   * as long as the no-wait nudge's reply bound. Armed at the submission, and again at a turn end
   * that leaves the run running without it; the acknowledgement and runner activity cancel it.
   * At expiry the run notes the unanswered nudge and closes through the idle path: it settles
   * `waiting` once its process has exited, with no human wait.
   */
  armAutonomousNudgeBound(runId: string, state: ActiveRun): void {
    this.armUnansweredNudgeBound(runId, state, 'acknowledgement', nudgeAwaitsAcknowledgement, AUTONOMOUS_NO_ACK_NOTE);
  }

  /**
   * The bound of an autonomous nudge the harness acknowledged, while its session shows no model
   * work (hearsay-tools/squawk#3741). An acknowledgement means the transport took the input, not
   * that a turn started. It has the acknowledgement bound's length and expiry; model work cancels
   * it, and heartbeats do not.
   */
  armAutonomousNudgeAnswerBound(runId: string, state: ActiveRun): void {
    this.armUnansweredNudgeBound(runId, state, 'nudge-answer', nudgeAwaitsAnswer, AUTONOMOUS_NO_REPLY_NOTE);
  }

  private armUnansweredNudgeBound(runId: string, state: ActiveRun, kind: 'acknowledgement' | 'nudge-answer',
    holds: (state: ActiveRun, session: AgentSession) => boolean, message: string): void {
    const session = state.liveSession.session;
    if (!session?.open || !holds(state, session)) return;
    this.timers.arm({ kind, runId, delayMs: this.noWaitNudgeReplyMs,
      session: { armed: session, current: () => state.liveSession.session } }, () => {
      if (this.context.disposed() || this.host.active.get(runId) !== state || !session.open || state.liveSession.cancelled ||
        state.liveSession.finishRequested || !holds(state, session)) return;
      this.host.abandonNudgeFlight(state, session);
      this.host.closeIdleSession(runId, state, { type: 'note', tone: 'warning', ...(state.liveSession.currentStepId ? { stepId: state.liveSession.currentStepId } : {}), message });
    });
  }

  /** The harness acknowledged the nudge `session` was sent: its acknowledgement bound ends, and the
   *  fact records it. An autonomous nudge whose session showed no model work since the send gets
   *  its answer bound (hearsay-tools/squawk#3741). */
  acknowledgeNudge(runId: string, state: ActiveRun, session: AgentSession): void {
    if (state.boundary.nudge?.session !== session || state.boundary.nudge.state !== 'submitted') return;
    const { cause, answered } = state.boundary.nudge;
    recordNudge(state, { cause, state: 'acknowledged', ...(answered ? { answered } : {}) });
    this.timers.clear('acknowledgement', runId);
    if (!answered) this.armAutonomousNudgeAnswerBound(runId, state);
  }

  /** Model work in the nudge's own session is its reply: its bounds stop while the turn runs. A turn
   *  end that still finds the acknowledgement missing arms it again. Both event paths name the session
   *  that emitted the event, so a retired session's late events stop nothing (hearsay-tools/squawk#2443). */
  noteNudgeActivity(runId: string, state: ActiveRun, emitting: AgentSession | undefined, event: NudgeEvent): void {
    if (!emitting || this.host.active.get(runId) !== state || state.liveSession.session !== emitting ||
      state.boundary.nudge?.session !== emitting || !isModelActivity(event)) return;
    const nudge = state.boundary.nudge;
    if (event.type !== 'turn.started' && nudge.state === 'submitted' && !nudge.answered) recordNudge(state, { cause: nudge.cause, state: nudge.state, answered: true });
    this.timers.clear('acknowledgement', runId);
    this.timers.clear('nudge-answer', runId);
  }

  /** The nudge a turn end with no wait or done gets: one automatic turn, charged to the
   *  automatic-wake budget. The autonomous wording repeats; the no-wait one is sent once and is
   *  bounded by its reply timer (#544's liveness). */
  sendTurnEndNudge(runId: string, state: ActiveRun, stepId: string | undefined, text: string): boolean {
    if (state.boundary.autonomous) return !!stepId && this.tryAutonomousNudge(runId, state, stepId, text);
    if (!this.canAutoContinue(runId, state)) return false;
    transitionTurnBoundary(state, { kind: 'turn-end', phase: 'reset-content', session: state.liveSession.session });
    if (!this.host.submitAgentInput(runId, state, [{ type: 'text', text }])) return false;
    transitionTurnBoundary(state, { kind: 'input-submitted', phase: 'nudge-delivered', session: state.liveSession.session });
    recordNudge(state, { cause: 'no-wait', state: 'submitted' });
    clearIdleTimer(state);
    this.armNoWaitNudgeReplyTimer(runId, state);
    const spent = this.host.chargeAutomaticWake(runId);
    this.context.store.eventLog.appendEvent(runId, { type: 'note', ...(stepId ? { stepId } : {}), message: `${NO_WAIT_NUDGE_NOTE} (${spent}/${this.maxAutoContinues})` });
    return true;
  }

  /** Heartbeats, nested subagent items and late display updates are not a reply. A `turn.started` counts only while the
   *  reply timer runs or after it expired on this session: OpenCode emits a synthetic one
   *  inside `sendAgentMessage`, and a later send goes through `submitAgentInput`, which resumes. */
  isNoWaitNudgeReply(state: ActiveRun, event: NudgeEvent): boolean {
    if (event.type === 'turn.started') return state.boundary.noWaitNudgeReplyTimer !== undefined || state.boundary.noWaitNudgeParked === state.liveSession.session;
    if (event.type === 'text' || event.type === 'tool-call' || event.type === 'tool-result') return true;
    if (event.type === 'item.delta' || !event.type.startsWith('item.')) return false;
    return event.item?.parentItemId === undefined && event.late !== true;
  }

  /** A reply to the nudge clears its bound. One that arrives after the bound parked the run resumes
   *  it, as the final-message nudge's did (#544); its turn end then decides, and a run still on
   *  Squawk's no-wait wait parks on it again. Only the live session's own events count: one `ActiveRun`
   *  spans workflow steps, so a retired step's late reply must not clear the current bound
   *  (hearsay-tools/squawk#3740). */
  noteNoWaitNudgeContent(runId: string, state: ActiveRun, emitting: AgentSession | undefined, event: NudgeEvent): void {
    if (!emitting || this.host.active.get(runId) !== state || state.liveSession.session !== emitting ||
      !this.isNoWaitNudgeReply(state, event)) return;
    transitionTurnBoundary(state, { kind: 'reply-content', phase: 'received', session: state.liveSession.session });
    clearNoWaitNudgeReplyTimer(state);
    if (state.boundary.noWaitNudgeParked !== state.liveSession.session || !this.line.isParked(runId)) return;
    if (state.boundary.pendingHumanAsk || hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store.transcriptFacts, id))) return;
    this.host.resumeParkedRun(runId, state);
    transitionTurnBoundary(state, { kind: 'reply-content', phase: 'resumed', session: state.liveSession.session });
  }

  /** A no-wait nudge the harness acknowledged but never answered (an OpenCode heartbeat keeps the
   *  session alive without a turn): at the bound Squawk opens the no-wait human wait and the run
   *  waits for the user. A reply that arrives after it runs, and the run stays on that question. */
  armNoWaitNudgeReplyTimer(runId: string, state: ActiveRun): void {
    clearNoWaitNudgeReplyTimer(state);
    if (state.boundary.noWaitNudgeSawContent) return;
    const session = state.liveSession.session;
    if (!session?.open) return;
    const timer = this.timers.arm({ kind: 'nudge-reply', runId, delayMs: this.noWaitNudgeReplyMs,
      session: { armed: session, current: () => state.liveSession.session },
      forget: () => transitionTurnBoundary(state, { kind: 'reply-expired', phase: 'fired', session }) }, () => {
      if (this.context.disposed() || this.host.active.get(runId) !== state || !session.open ||
        state.liveSession.cancelled || state.liveSession.finishRequested || this.line.isParked(runId)) return;
      transitionTurnBoundary(state, { kind: 'reply-expired', phase: 'park', session });
      // The note names the nudge left unanswered (hearsay-tools/cezarion#1301).
      this.host.openTurnEndHumanWait(runId, state, state.liveSession.currentStepId, 'no-wait', state.boundary.completionNudged === session ? COMPLETION_NO_REPLY_NOTE : NO_WAIT_NO_REPLY_NOTE);
      this.host.settledTurnOutcome(runId, 'reply-timer', { kind: 'park', keepsSlot: false });
    });
    transitionTurnBoundary(state, { kind: 'reply-expired', phase: 'armed', session, timer });
  }
}
