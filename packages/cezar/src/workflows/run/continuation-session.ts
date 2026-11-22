import { cleanupTaskWorktreeSkills } from '../../worktree-skill-cleanup.ts';
import { WAIT_KINDS } from './wait-kinds.ts';
import { runDataDir } from '../../legacy-runs.ts';
import { fallbackProjectWriteError } from '../../project-paths.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';
import { continuationNextStep, waitingWorkflowStepIndex, ciWorkflowResumeStepIndex } from './workflow-position.ts';
import type { QueuedInput } from './queued-input.ts';
import type { WorkerQuestions } from './worker-questions.ts';
import { join } from 'node:path';
import type { ContentBlock } from '../../core/agent-runner.ts';
import { inputDeliveryOf } from '../../core/agent-runner-values.ts';
import { startManagedSession } from '../../core/managed-session.ts';
import { pastedAttachmentsText, type PastedContent, type PersistedAttachment } from '../pasted-content.ts';
import type { AutosaveReason } from '../../autosave-commit.ts';
import { continuationOpening } from './opening.ts';
import { createSessionEventHandler, launchPreamble, type SessionEventHandler } from './session-events.ts';
import { agentDirectories, composeSystemPrompt, leadingSlashSkillName } from './prompts.ts';
import { continuationRunner } from './launch-settings.ts';
import { preserveRunAfterDisposal } from './run-guards.ts';
import { stepScope } from './steps.ts';
import { clearIdleTimer } from './input-timers.ts';
import * as inputReceipts from './input-receipts.ts';
import type { HumanWaits } from './human-waits.ts';
import type { RunSettlement } from './run-settlement.ts';
import type { SessionTurn, ContinuationSessionLaunch, ContinuationClose, LaunchDelegation, LaunchCiTools } from './types.ts';
import type { AgentRunner, AgentSession } from '../../core/agent-runner.ts';
import type { WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import { seedHandoffFile } from '../../handoff.ts';
import { atContinue } from './launch-read-resolver.ts';
import type { CezConfig } from '../../config.ts';
import type { ActiveRun } from '../active-run.ts';
import { openWaits } from '../waits.ts';
import type { RunOutcome } from '../../runs/outcome-commit.ts';
import type { UiEventSink } from '../../runs/ui-event-sink.ts';
import { toolGrantLists } from '../types.ts';
import { continuationModel, continuationEffort } from './launch-settings.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';
import { clearAutosaveTimer } from './input-timers.ts';
import { REPOSITORY_ROOT_LOCK_DISABLED_NOTE } from './run-workspace.ts';
import type { RepoRootLease } from './repo-root-lease.ts';
import type { WorktreeAutosave } from './worktree-autosave.ts';
import type { RunSkills } from './run-skills.ts';
import * as sessionEvents from './session-events.ts';
import type { PendingContinuation, ContinuationOpening, OpeningAnswer, ContinuationSettings, ContinuationSkills } from './types.ts';
import { existsSync } from 'node:fs';
import type { RunRecord, StepState } from '../../runs/store.ts';
import { rematerializeReclaimedWorktree } from '../../runs/retention.ts';
import { ownedContinuationWorkspace } from './run-workspace.ts';
import type { WorkerWorkspacePort } from './worker-workspace-port.ts';
import type { RunExitId, RunPatch } from '../../runs/run-exits.ts';
import type { RunLine } from './run-line.ts';
import type { RunModuleContext, WorkerDelegationRecord } from './types.ts';

export interface ContinuationSessionHost {
  move(runId: string, exit: RunExitId, patch?: RunPatch): void;
  dropActive(runId: string): void;
  repositoryRootLockDisabled(): boolean;
  beginUsageInvocation(runId: string, state: ActiveRun, stepId: string): void;
  trackWorkerSessionResult(runId: string, session: AgentSession): Promise<void>;
  recordUsagePeaks(runId: string): void;
  saveWorktree(runId: string, state: ActiveRun, reason: AutosaveReason): Promise<void>;
  pump(): Promise<void>;
  isSyntheticContinuation(run: RunRecord, step: StepState): boolean;
  makeUiSink(runId: string, stepId: string): UiEventSink;
  prepareWorktree(runId: string, state: ActiveRun, config: CezConfig['worktreeSetup'], emit: (event: { type: string; [key: string]: unknown }) => void, reason: 'rematerialized' | 'resume'): Promise<string | undefined>;
  workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined;
  latchAgentInputError(runId: string, state: ActiveRun, session: AgentSession, message: string): void;
  reconcileWorkerWaits(): void;
  workerWorkspaces(): WorkerWorkspacePort | undefined;
  holdContinuationForRootFinish(runId: string, item: PendingContinuation, state?: ActiveRun): boolean;
}

/** Owns the Continue workspace and launch session. */
export class ContinuationSession {
  constructor(
    private readonly context: RunModuleContext,
    private readonly host: ContinuationSessionHost,
    private readonly line: RunLine,
    private readonly sharedHost: sessionEvents.SessionHelperHost,
    private readonly repoRootLease: RepoRootLease,
    private readonly autosave: WorktreeAutosave,
    private readonly runSkills: RunSkills,
    private readonly sessionEventHost: sessionEvents.SessionEventHost,
    private readonly launchPreambleHost: sessionEvents.LaunchPreambleHost,
    private readonly inputReceiptHost: inputReceipts.InputReceiptsHost,
    private readonly inputReceiptSteps: inputReceipts.InputReceiptSteps,
    private readonly humanWaits: HumanWaits,
    private readonly queuedInput: QueuedInput,
    private readonly workerQuestions: WorkerQuestions,
    private readonly runSettlement: RunSettlement,
  ) {}

  /** Where a Continue runs: an owned worker's verified workspace, or the task's worktree, which
   *  retention may have reclaimed (#483), else the repository root. Returns undefined after an
   *  unavailable owned workspace failed the run. */
  async continuationWorkspace(
    runId: string,
    stepId: string,
    record: RunRecord | undefined,
  ): Promise<{ cwd: string; rematerialized: boolean } | undefined> {
    const path = record?.worktreePath ?? (record?.delegation?.role === 'worker' ? record.delegation.workspace.path : undefined);
    const refusal = path && fallbackProjectWriteError(path);
    if (refusal) { this.failWorkspace(runId, stepId, refusal); return undefined; }
    if (record?.delegation?.role === 'worker') {
      const cwd = await this.ownedContinuationWorkspace(runId, stepId, record, record.delegation);
      return cwd === undefined ? undefined : { cwd, rematerialized: false };
    }
    // Retention (#483) rebuilt a reclaimed directory: a bare checkout that needs setup again (#917).
    const rematerialized = await rematerializeReclaimedWorktree(this.context.repoRoot, this.context.store, runId);
    const cwd = record?.worktreePath && existsSync(record.worktreePath) ? record.worktreePath : this.context.repoRoot;
    return { cwd, rematerialized };
  }

  /** An owned worker's workspace for a Continue, verified with its parent's context. Returns
   *  undefined after it failed the run: owned workers never adopt or recreate an unverified resource. */
  private async ownedContinuationWorkspace(
    runId: string,
    stepId: string,
    record: RunRecord,
    delegation: WorkerDelegationRecord,
  ): Promise<string | undefined> {
    try {
      return await ownedContinuationWorkspace(this.context.store, this.context.repoRoot, this.context.dataDir, record, delegation, this.host.workerWorkspaces());
    } catch (error) {
      const message = `owned workspace unavailable: ${error instanceof Error ? error.message : String(error)}`;
      this.failWorkspace(runId, stepId, message);
      return undefined;
    }
  }

  private failWorkspace(runId: string, stepId: string, message: string): void {
    const finishedAt = new Date().toISOString();
    this.context.store.updateStep(runId, stepId, { status: 'failed', error: message, finishedAt });
    this.host.move(runId, 'fail-start', { error: message, finishedAt });
    this.context.store.appendEvent(runId, { type: 'lifecycle', message });
    this.line.unmarkStarting(runId);
    this.host.dropActive(runId);
  }

  /** A Stop that arrived while the Continue resolved its workspace cancels the run before it
   *  becomes active. */
  settleStoppedContinuation(runId: string): boolean {
    if (!this.context.store.getRun(runId)?.stopping) return false;
    this.host.move(runId, 'cancel');
    this.line.unmarkStarting(runId);
    this.host.dropActive(runId);
    return true;
  }

  /** The repository-root lease of a Continue that runs in the repository root. Returns undefined
   *  when no lease is needed, so that path does not yield, else whether the lease was granted. */
  private continuationRepoRootLease(runId: string, state: ActiveRun): Promise<boolean> | undefined {
    if (state.liveSession.cwd !== this.context.repoRoot || state.liveSession.sharesDirectory) return undefined;
    if (this.host.repositoryRootLockDisabled()) {
      this.context.store.appendEvent(runId, {
        type: 'note',
        message: REPOSITORY_ROOT_LOCK_DISABLED_NOTE,
      });
      return undefined;
    }
    this.context.store.appendEvent(runId, {
      type: 'note',
      message: 'waiting for exclusive access to the repository working tree',
    });
    return this.acquireContinuationRepoRoot(runId, state);
  }

  /** Wait for the repository-root lease; a Stop during the wait cancels the run. */
  private async acquireContinuationRepoRoot(runId: string, state: ActiveRun): Promise<boolean> {
    if (await this.repoRootLease.acquireRepoRoot(runId, state)) return true;
    this.host.move(runId, 'cancel');
    this.host.dropActive(runId);
    return false;
  }

  /** Arm autosave, seed the handoff file, and run worktree setup. Returns setup's note for the
   *  opening message. */
  private async prepareContinuationWorktree(
    runId: string,
    state: ActiveRun,
    record: RunRecord | undefined,
    rematerialized: boolean,
  ): Promise<string | undefined> {
    this.autosave.armAutosave(runId, state);
    if (record) seedHandoffFile(this.context.dataDir, record); // idempotent — normally already there
    // Worktree setup (#917) for a directory retention rebuilt, or one a restart interrupted.
    return this.host.prepareWorktree(
      runId,
      state,
      atContinue.worktreeSetup(await atContinue.config(this.context.repoRoot, this.context.home)),
      (event) => this.context.store.appendEvent(runId, event),
      rematerialized ? 'rematerialized' : 'resume',
    );
  }

  /** Mark the run and the Continue's step as running, then open the step. */
  private startContinuationStep(
    runId: string,
    stepId: string,
    record: RunRecord | undefined,
    sessionId: string | undefined,
    backend: string,
  ): void {
    this.host.move(runId, 'start', {
      error: undefined,
      finishedAt: undefined,
      currentStepId: stepId,
    });
    this.context.store.updateStep(runId, stepId, {
      status: 'running',
      iterations: 1,
      startedAt: new Date().toISOString(),
      sessionId,
      backend,
    });
    this.context.store.appendEvent(runId, { type: 'step-start', stepId, name: 'Continue', kind: 'agent', iteration: 1 });
  }

  /** The human ask a human Continue answers, and the human waits that answer settles. */
  private openingAnswer(runId: string, state: ActiveRun, opening: ContinuationOpening): OpeningAnswer {
    const askSeq = opening.checkpoint?.origin === 'human' ? pendingHumanAskSeq(this.context.store.transcriptFacts, runId) : undefined;
    state.inputState.answerOpeningAsk(askSeq);
    // The human waits this answer answers; one the opening turn opens is its next question.
    const waits = askSeq === undefined ? []
      : openWaits(this.context.store.getRun(runId) ?? {}).filter(wait => WAIT_KINDS[wait.kind].userAnswers).map(wait => wait.id);
    return { askSeq, waits, ...(opening.answerSource ? { answerSource: opening.answerSource } : {}) };
  }

  /**
   * A completed turn acknowledges the opening payload. Until then a restart
   * must replay it, including a crash after startSession but before delivery.
   * Returns false when the opening input's checkpoint failed, and the turn end stops there.
   */
  private acknowledgeOpeningTurn(runId: string, state: ActiveRun, answer: OpeningAnswer): boolean {
    if (state.liveSession.cancelled) return true;
    const session = state.liveSession.session?.open ? state.liveSession.session : undefined;
    const opening = session ? state.inputState.openingAgentInputId : undefined;
    const askSeq = session ? answer.askSeq : undefined;
    // One commit (hearsay-tools/cezarion#1805): a store reopened after a crash never reads the
    // opening input handled while the question it answers is still open.
    const outcomes: RunOutcome[] = [
      ...(opening ? [{ kind: 'opening-handled' as const, inputId: opening, at: new Date().toISOString() }] : []),
      ...(askSeq !== undefined ? [{ kind: 'answered' as const, waitIds: answer.waits, askSeq }] : []),
    ];
    // Only the opening input's checkpoint stops the turn end; the rest is best effort, as before.
    try { this.context.store.commitOutcome(runId, outcomes, { patch: { continuationMessage: undefined } }, { bestEffort: !opening }); }
    catch (error) { this.host.latchAgentInputError(runId, state, session!, `agent input delivery checkpoint failed: ${error instanceof Error ? error.message : String(error)}`); return false; }
    if (opening) { state.inputState.selectOpeningInput(undefined); this.host.reconcileWorkerWaits(); }
    if (askSeq !== undefined) {
      this.context.store.appendEvent(runId, { type: 'human-input-delivered', askSeq, ...(answer.answerSource ? { source: answer.answerSource } : {}) });
      answer.askSeq = undefined;
      state.inputState.clearOpeningAnswer();
    }
    return true;
  }

  /**
   * What a Continue runs with. Backend + model come off the record: the run's current backend by
   * default, or the follow-up override that `continueRun` persisted before scheduling (#401).
   * Returns undefined after a pre-spawn gate failed the turn.
   */
  private async continuationLaunchSettings(
    runId: string,
    stepId: string,
    state: ActiveRun,
    record: RunRecord | undefined,
    sessionId: string | undefined,
    backend: string,
    sink: UiEventSink,
  ): Promise<ContinuationSettings | undefined> {
    // Resuming reattaches to a session that lives inside ONE account's config dir, so the
    // continuation must run under the account that created it — not whatever the project has
    // been switched to since. The owning step is the one carrying this session id.
    const owningStep = atContinue.owningStep(record, sessionId);
    // Which step this Continue continues does not depend on whether it resumes that step's
    // session: a fresh session after a backend switch or an unreported native id continues the
    // same step (hearsay-tools/cezarion#2991). An owned worker's turn runs under the identity
    // pinned for that step (#452).
    const toolsStep = atContinue.definitionStep(this.context.store, record, atContinue.continuedSessionId(record, stepId, sessionId));
    const stepIdentity = this.host.workerStep(runId, atContinue.definitionId(toolsStep));
    // The continued step also names the session's tools: resolve `allowedTools`/`bashAllowlist`
    // from the persisted `workflowDef` exactly as the first spawn did (`runAgentStep`).
    // Rebuilding with the bare DEFAULT_ALLOWED_TOOLS silently revoked every per-step grant
    // (MCP servers, subagents) on Continue, restart recovery and the usage-limit auto-resume
    // — and dropping `bashAllowlist` WIDENED Bash from an allowlist to unrestricted
    // (`AgentRunSpec.toolGrant`, #430). Record steps share ids with `workflowDef.steps`;
    // a synthetic `continue-N` that owns its session resolves to the step it recorded at
    // admission (`continuesStepId`), and one saved without it to the definition's last agent
    // step. A legacy record without `workflowDef` (#367), or a session no step owns, keeps
    // today's defaults.
    const toolGrant = atContinue.toolGrant(stepIdentity, toolsStep, backend);
    const model = await continuationModel(this.context.store, this.context.repoRoot, runId, state, record, toolsStep, stepIdentity, backend, this.context.home);
    if (typeof model === 'string') { this.failContinuationBeforeSpawn(runId, stepId, sink, model); return undefined; }
    const effort = continuationEffort(this.context.repoRoot, record, toolsStep, stepIdentity, this.context.home);
    if (typeof effort === 'string') { this.failContinuationBeforeSpawn(runId, stepId, sink, effort); return undefined; }
    // The temp-directory preflight (#785) rides along with the account resolution: a resumed
    // turn hits the same broken `/tmp` a fresh one would, and an agent whose shell silently
    // returns nothing is worse than a turn that refuses to start and says why. So does an account
    // that would open another folder than the one its session lives in (#1283).
    const profile = await sessionEvents.stepProfileFor(this.context, this.sharedHost, runId, backend, {
      recordedProfileId: atContinue.recordedProfile(owningStep),
      phase: 'continue',
      stepId: atContinue.definitionId(toolsStep),
    });
    if (typeof profile === 'string') { this.failContinuationBeforeSpawn(runId, stepId, sink, profile); return undefined; }
    return {
      owningStep, toolsStep, toolGrant, backendModel: model.backendModel, effort: effort.effort, profile,
      extraSystemPrompt: atContinue.extraSystemPrompt(record),
    };
  }

  /** Settle this turn as a failure before anything is spawned — the shape every
   *  pre-spawn gate needs (model identity, #405; temp directory, #785). */
  private failContinuationBeforeSpawn(runId: string, stepId: string, sink: UiEventSink, message: string): void {
    const failedAt = new Date().toISOString();
    sink.sessionEnded('error', message);
    this.context.store.updateStep(runId, stepId, {
      status: 'failed',
      error: message,
      finishedAt: failedAt,
    });
    this.host.move(runId, 'fail-start', { error: `continue failed: ${message}`, finishedAt: failedAt });
    this.context.store.appendEvent(runId, {
      type: 'lifecycle',
      message: `continue failed — ${message}`,
    });
    this.host.dropActive(runId);
  }

  /** Record the Continue's account on its step and the settings its workers inherit. */
  private applyContinuationSettings(
    runId: string,
    stepId: string,
    state: ActiveRun,
    backend: string,
    settings: ContinuationSettings,
  ): void {
    this.context.store.updateStep(runId, stepId, { profileId: settings.profile.profileId, ...(settings.owningStep?.skillPath ? { skillPath: settings.owningStep.skillPath } : {}) });
    state.liveSession.captureDelegationSettings({ cwd: state.liveSession.cwd, runner: backend, model: settings.backendModel,
      effort: settings.effort, agentProfile: settings.profile.profileId, accountBinding: settings.profile.accountBinding,
      systemPrompt: settings.extraSystemPrompt, ...toolGrantLists(settings.toolGrant) });
  }

  /** A Stop before the Continue's session spawned: cancel the step and the run. */
  private settleContinuationPrelaunchCancel(runId: string, stepId: string, state: ActiveRun): void {
    // Its own step may not have started: the exit settles only running and waiting steps (B10).
    this.context.store.updateStep(runId, stepId, { status: 'cancelled', finishedAt: new Date().toISOString() });
    this.host.move(runId, 'cancel');
    clearAutosaveTimer(state); this.host.dropActive(runId);
  }

  /** A Continue's launch went stale while it provisioned (`launchStale`). A replaced active run
   *  needs nothing more; a Stop cancels the run; a root Finish holds the Continue in the queue. */
  private settleStaleContinuationLaunch(
    runId: string,
    stepId: string,
    state: ActiveRun,
    held: Omit<PendingContinuation, 'lineJoinedAt'>,
  ): void {
    const disposition = staleContinuationDisposition(this.sharedHost.active.get(runId), state, () => this.sharedHost.workerExecutionStopped(runId));
    if (disposition === 'replaced') return;
    if (disposition === 'cancel') {
      state.liveSession.cancel();
      this.settleContinuationPrelaunchCancel(runId, stepId, state);
    } else {
      this.host.holdContinuationForRootFinish(runId, atContinue.rejoinLine(held), state);
    }
  }

  /** Launch the active Continue after its facade has pinned it and left the starting set. */
  async launchContinuation(
    runId: string,
    stepId: string,
    sessionId: string | undefined,
    backend: string,
    prompt: string,
    images: PastedContent[],
    persistedImages: ContentBlock[],
    persistedAttachments: PersistedAttachment[],
    state: ActiveRun,
    record: RunRecord | undefined,
    rematerialized: boolean,
  ): Promise<void> {
    const lease = this.continuationRepoRootLease(runId, state);
    if (lease && !(await lease)) return;
    const setupNote = await this.prepareContinuationWorktree(runId, state, record, rematerialized);
    // A Stop during setup settles below, at the prelaunch cancellation check before any spawn.
    // Each new runner process reads its own native skill list.

    this.startContinuationStep(runId, stepId, record, sessionId, backend);
    const turn: SessionTurn = { text: '', scheduleWakeup: undefined, sessionError: undefined };
    const sink = this.host.makeUiSink(runId, stepId);
    const settings = await this.continuationLaunchSettings(runId, stepId, state, record, sessionId, backend, sink);
    if (!settings) return;
    if (state.liveSession.cancelled) { this.settleContinuationPrelaunchCancel(runId, stepId, state); return; }
    if (this.host.holdContinuationForRootFinish(runId, { stepId, sessionId, backend, prompt, images, lineJoinedAt: Date.now() }, state)) return;
    this.applyContinuationSettings(runId, stepId, state, backend, settings);
    const { runner } = await continuationRunner(backend, sessionId, settings.owningStep, this.context.createRunner);
    await cleanupTaskWorktreeSkills(state.liveSession.cwd, this.context.store.getRun(runId)?.worktreePath, this.context.repoRoot,
      message => this.context.store.appendEvent(runId, { type: 'note', message }));
    await this.runSkills.loadRunSkills(state, backend, settings.profile);
    if (state.liveSession.cancelled) { this.settleContinuationPrelaunchCancel(runId, stepId, state); return; }
    const opening = continuationOpening(this.context.store, {
      answerSource: (id, input) => this.workerQuestions.answerSource(id, input),
      readPersistedAttachments: (...args) => this.queuedInput.readPersistedAttachments(...args),
    }, runId, stepId, state, record, { prompt, images, persistedImages, persistedAttachments });
    prompt = opening.prompt;
    const answer = this.openingAnswer(runId, state, opening);
    transitionTurnBoundary(state, { kind: 'session-open', phase: 'restore-question', session: state.liveSession.session, pending: answer.askSeq === undefined && hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store.transcriptFacts, id)) });

    const onEvent = createSessionEventHandler(this.context, this.sessionEventHost, {
      runId, state, turn, stepId, backend, sink, tokenBase: 0,
      emit: event => this.context.store.appendEvent(runId, event),
      acknowledge: () => this.acknowledgeOpeningTurn(runId, state, answer),
    });

    const skills: ContinuationSkills = { fallback: this.runSkills.selectedSkill(state, settings.toolsStep?.skill,
      settings.owningStep?.skillPath, '') };
    const native = await this.runSkills.openingInput(runId, state, [{ type: 'text', text: prompt }]);
    if (native[0]?.type === 'skill') { skills.trigger = native[0]; prompt = ''; }
    state.liveSession.selectStep(stepId);
    this.host.beginUsageInvocation(runId, state, stepId);
    // The transcript retains the user's text. Only the runner receives the native trigger.
    state.liveSession.recordSessionError(undefined);
    if (this.sharedHost.workerExecutionStopped(runId)) { state.liveSession.cancel(); throw new Error('Worker stopped before launch'); }
    const launch = await launchPreamble(this.launchPreambleHost, runId, state);
    const { delegation, webhooksPart, ciTools } = launch;
    // Stop/Finish can arrive while the local tool controller is starting.
    if (launch.stale) {
      this.settleStaleContinuationLaunch(runId, stepId, state, { stepId, sessionId, backend, prompt, images });
      return;
    }
    // hearsay-tools/cezarion#2397: the tools could not start, so nothing spawns. The failure takes
    // the session-failure path: a run that holds wakes parks and retries them with the wake-delivery
    // backoff; any other run fails with the message.
    if (launch.toolsError !== undefined) {
      this.runSettlement.settleFailedContinuation(runId, state, stepId, sink, turn, new Error(launch.toolsError));
      await this.releaseContinuationSession(runId, state, undefined, undefined, {});
      return;
    }
    state.inputState.declareDelivery(inputDeliveryOf(runner)); state.inputState.resetUnreadInputs(); state.inputState.resetEarlyConsumption();
    const session = this.startContinuationSession(runId, state, runner, {
      stepId, sessionId, prompt, setupNote, opening, skills, settings, delegation, webhooksPart, ciTools,
    }, onEvent, turn, sink);
    return this.awaitContinuationSession(runId, state, session, { stepId, sink, turn, delegation, ciTools });
  }

  /** Start a Continue's session, resuming its own session when it has one. A throw revokes the
   *  tools this launch was given and propagates to `continueRun`. */
  private startContinuationSession(
    runId: string,
    state: ActiveRun,
    runner: AgentRunner,
    launch: ContinuationSessionLaunch,
    onEvent: SessionEventHandler,
    turn: SessionTurn,
    sink: UiEventSink,
  ): AgentSession {
    const { delegation, ciTools, opening, skills, settings } = launch;
    let session: AgentSession | undefined;
    try {
      // The adapter selects the fallback only when it opens a fresh session.
      const resumed = sessionEvents.launchOpening(this.context, this.sharedHost, runId, state, launch.stepId, {
        body: launch.prompt +
          (launch.setupNote ? `\n\n${launch.setupNote}` : ''),
        ciTools,
        checkpoint: opening.checkpoint,
      });
      // A resumed native command keeps character zero. If bootstrap opens a fresh
      // session, the fallback trigger consumes that command and must carry its context.
      const resumeFallbackSkill = skills.fallback && leadingSlashSkillName(resumed.userPrompt)
        ? { ...skills.fallback, args: this.sharedHost.sessionContextFor(runId, state, launch.stepId, '').prefix }
        : skills.fallback;
      const continuationTail = sessionEvents.launchSystemTail(this.context, this.sharedHost, {
        extraSystemPrompt: settings.extraSystemPrompt, delegation, webhooksPart: launch.webhooksPart,
        env: settings.profile.env, ciTools, handoffInjected: resumed.handoffInjected, runner: state.liveSession.delegationSettings?.runner,
      });
      session = startManagedSession(runner,
        {
          timings: this.context.timings,
          scope: this.context.store.spawnScope(runId),
          // The system prompt holds the shared tail. Skill text stays with the runner.
          systemPrompt: composeSystemPrompt(undefined, continuationTail),
          ...(resumeFallbackSkill ? { resumeFallbackSkill } : {}),
          ...(skills.trigger ? { skill: skills.trigger } : {}),
          userPrompt: opening.attachments.length
            ? `${resumed.userPrompt}\n\n${pastedAttachmentsText(opening.attachments)}`
            : resumed.userPrompt,
          ...(opening.openingImages.length ? { images: opening.openingImages } : {}),
          cwd: state.liveSession.cwd,
          toolGrant: settings.toolGrant,
          additionalDirectories: agentDirectories(join(runDataDir(this.context.dataDir, runId), 'runs'), settings.profile.env),
          env: { ...settings.profile.env, ...delegation?.env, ...ciTools?.env },
          ...(ciTools ? { squawkTools: ciTools.descriptor } : {}),
          ...(delegation ? { restrictCrossSessionMessaging: delegation.restrictCrossSessionMessaging } : {}),
          model: settings.backendModel,
          effort: settings.effort,
          sessionId: launch.sessionId,
          resume: launch.sessionId !== undefined,
          timeoutMs: 0,
        },
        // Every agent event names the session that emitted it.
        event => onEvent(event, session),
        inputReceipts.inputReceiptCallbacks(this.context, this.inputReceiptHost, this.inputReceiptSteps, runId, state, () => session, turn, sink, true),
      );
    } catch (error) { ciTools?.revoke(); state.liveSession.clearCiRevoker(); delegation?.revoke(); state.liveSession.clearDelegationRevoker(); throw error; }
    return session;
  }

  /** Wait for a Continue's session to close, then settle the run by how it closed. Teardown always
   *  revokes the launch's tools, saves the worktree and leaves the active set
   *  (`releaseContinuationSession`). */
  private async awaitContinuationSession(runId: string, state: ActiveRun, session: AgentSession, launch: {
    stepId: string;
    sink: UiEventSink;
    turn: SessionTurn;
    delegation: LaunchDelegation;
    ciTools: LaunchCiTools;
  }): Promise<void> {
    const { stepId, sink, turn } = launch;
    const sessionClosed = this.host.trackWorkerSessionResult(runId, session);
    state.liveSession.attachSession(session);
    const resumedNext = continuationNextStep(this.context.store, runId, record => waitingWorkflowStepIndex(record,
      (run, step) => this.host.isSyntheticContinuation(run, step), ciWorkflowResumeStepIndex));
    transitionTurnBoundary(state, { kind: 'session-open', phase: 'scope-step', session, next: stepScope(session, resumedNext) });
    state.liveSession.markSessionOpened();
    state.liveSession.installInterrupt(() => session.interrupt());
    let setupComplete = false;
    const close: ContinuationClose = {};
    try {
      const result = await inputReceipts.sessionResultWithReceipts(this.context, this.inputReceiptHost, this.inputReceiptSteps, runId, state, session, () => { setupComplete = true; });
      if (preserveRunAfterDisposal(this.context.store, this.context.disposed, runId, state)) return;
      this.humanWaits.withdrawSquawkHumanWaits(runId);
      sessionEvents.persistWorkerAssistantResult(this.context, this.sharedHost, runId, stepId, result.text);
      // A durable CI wait keeps recovery live, not this failed attempt successful.
      if (turn.sessionError || state.inputState.agentInputError) throw new Error(turn.sessionError ?? state.inputState.agentInputError);
      const settled = this.runSettlement.settleClosedContinuation(runId, state, stepId, sink, resumedNext, close);
      if (settled) await settled;
    } catch (err) {
      if (!setupComplete) {
        try { session.interrupt(); } catch { /* Still wait for actual termination. */ }
        await sessionClosed;
      }
      if (preserveRunAfterDisposal(this.context.store, this.context.disposed, runId, state)) return;
      this.runSettlement.settleFailedContinuation(runId, state, stepId, sink, turn, err);
    } finally {
      await this.releaseContinuationSession(runId, state, launch.delegation, launch.ciTools, close);
    }
  }

  /** A Continue's session teardown: revoke the launch's tools, record the usage peaks, clear the
   *  timers, save the worktree, leave the active set, then queue the workflow remainder. */
  private async releaseContinuationSession(
    runId: string,
    state: ActiveRun,
    delegation: LaunchDelegation,
    ciTools: LaunchCiTools,
    close: ContinuationClose,
  ): Promise<void> {
    ciTools?.revoke(); state.liveSession.clearCiRevoker();
    delegation?.revoke(); state.liveSession.clearDelegationRevoker();
    this.host.recordUsagePeaks(runId);
    clearIdleTimer(state);
    clearAutosaveTimer(state);
    await this.host.saveWorktree(runId, state, 'turn end');
    // Cancellation may be accepted while final autosave is yielding, even
    // after success was recorded. Retire any durable queue intent before
    // dropping the active state, otherwise pump can launch the tail with a
    // fresh `cancelled:false` state.
    if (state.liveSession.cancelled) {
      close.resumeWorkflow = undefined;
      if (this.context.store.getRun(runId)?.status !== 'cancelled') {
        this.host.move(runId, 'cancel-late');
      }
    }
    this.host.dropActive(runId);
    if (close.resumeWorkflow) {
      this.line.enqueueJob(runId, close.resumeWorkflow);
      void this.host.pump();
    }
  }
}

export function staleContinuationDisposition(current: ActiveRun | undefined, state: ActiveRun, workerStopped: () => boolean): 'replaced' | 'cancel' | 'hold' {
  if (current !== state) return 'replaced';
  return state.liveSession.cancelled || workerStopped() ? 'cancel' : 'hold';
}
