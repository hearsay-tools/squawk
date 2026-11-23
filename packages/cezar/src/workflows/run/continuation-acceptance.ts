import { withCutOff } from './cut-off-work.ts';
import { atContinue, atTaskHead } from './launch-read-resolver.ts';

import { patchWorkerIdentity, readWorkerIdentity, resolveWorkerIdentity, type AcceptedWorkerIdentity, type WorkerPendingOverride, type WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import type { RunOutcome } from '../../runs/outcome-commit.ts';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/usage-limit-hold';
import type { RunRecord, StepState } from '../../runs/store.ts';
import type { RunWrites } from '../../runs/ports.ts';
import type { RunPatchInput } from '../../runs/ports.ts';
import * as continuation from '../continuation-admission.ts';
import type { ContinueRunOptions } from '../continuation-admission.ts';
import type { RunExitId } from '../../runs/run-exits.ts';
import { contentBlocksOf, type PastedContent } from '../pasted-content.ts';
import type { WorkflowDef } from '../types.ts';
import type { RunModuleContext, StartRunInput } from './types.ts';
import type { MaintenanceClaims } from './maintenance-claims.ts';
import type { RunLine } from './run-line.ts';
import type { WorkerExecutions } from './worker-executions.ts';
import type { QueuedInput } from './queued-input.ts';
import type { AutoResumeScheduler } from './auto-resume.ts';
import type { WorktreeAutosave } from './worktree-autosave.ts';
import type { WorkerQuestions } from './worker-questions.ts';
import { historyDeletionPending } from './run-guards.ts';
import { admissionRefusal } from '../../runs/worker-execution.ts';
import * as workflowPosition from './workflow-position.ts';
import { hasPendingHumanAsk, pendingHumanAskSeq } from './pending-ask-facts.ts';

interface WorkerIdentityOverride {
  previous: AcceptedWorkerIdentity;
  next: AcceptedWorkerIdentity;
  pending: WorkerPendingOverride;
  runPatch: { model?: string | undefined; effort?: string | undefined; modelIdentity?: undefined; workflowDef?: WorkflowDef };
}

interface ContinuationAcceptanceHost {
  isActive(runId: string): boolean;
  move(id: string, exit: RunExitId, patch?: Omit<RunPatchInput, 'status'>): RunRecord | undefined;
  ownedJob(run: RunRecord): { workflow: WorkflowDef; input: StartRunInput };
  executionBlockedByRootFinish(run: RunRecord): boolean;
  finishWorkerExecution(runId: string): Promise<void>;
  clearWakeBackoff(runId: string): void;
  dropActive(runId: string): void;
  pump(): Promise<void>;
  runContinuation(runId: string, stepId: string, sessionId: string | undefined, backend: string, prompt: string, images: PastedContent[]): Promise<void>;
  workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined;
  isUntouchedCancelledRun(run: RunRecord): boolean;
  isSyntheticContinuation(run: RunRecord, step: StepState): boolean;
}

export class ContinuationAcceptance {
  constructor(private readonly context: RunModuleContext, private readonly host: ContinuationAcceptanceHost,
    private readonly claims: MaintenanceClaims, private readonly line: RunLine, private readonly workerExecutions: WorkerExecutions,
    private readonly queuedInput: QueuedInput, private readonly autoResumeScheduler: AutoResumeScheduler,
    private readonly worktreeAutosave: WorktreeAutosave, private readonly workerQuestions: WorkerQuestions,
    private readonly routedQuestionRefusal: string, private readonly restartContinuationPrompt: string) {}
  /** Accepted Continues supersede in-flight settlement even before launch or after
   * idle close. Retain these across dropActive/dispose so absence cannot look like
   * the earlier execution again; disposal alone never revokes terminal intent.
   * Kept here, not in `RunMemory`, which releases on dispose: `successSuperseded`
   * compares this token after its diff and config I/O, also for an accepted Finish
   * that survives disposal (ADR 0064). */
  private readonly continuationGenerations = new Map<string, symbol>();
  generation(runId: string): symbol | undefined { return this.continuationGenerations.get(runId); }

  /** Saves an accepted continuation. A human Continue also answers every human wait, ends failed
   *  deliveries and restarts the budget, in the same best-effort commit. */
  private commitContinuation(runId: string, human: boolean): void {
    const outcomes: RunOutcome[] = [{ kind: 'answered' }, { kind: 'counted', waitDeliveryFailures: undefined },
      ...(this.context.store.getRun(runId)?.automaticWakes ? [{ kind: 'charged' as const, automaticWakes: 0 }] : [])];
    if (!human || !this.context.store.commitOutcome(runId, outcomes, {}, { bestEffort: true }).committed) this.context.store.persistence.flush();
  }

  admitContinuation(
    runId: string,
    opts: ContinueRunOptions,
    deferForCapacity: boolean,
    conversation: continuation.ContinuationConversation,
  ): continuation.ContinuationResult {
    const admitted = new continuation.ContinuationChecks(runId, this.context.repoRoot, opts, deferForCapacity, conversation, {
      active: () => this.host.isActive(runId),
      autosaveBlocker: () => this.claims.autosaveStartBlocker(runId),
      reclaiming: () => this.claims.blocksStart(runId),
      run: () => this.context.store.getRun(runId),
      historyDeletionPending: () => historyDeletionPending(this.context.store, runId),
      parentStatus: parentId => this.context.store.getRun(parentId)?.status,
      identity: (run, session) => this.host.workerStep(runId, atContinue.definitionId(atContinue.definitionStep(this.context.store, run, session, this.host.isUntouchedCancelledRun(run)))),
      identityStepId: (run, session) => atContinue.definitionId(atContinue.definitionStep(this.context.store, run, session, this.host.isUntouchedCancelledRun(run))),
      continuedStep: (run, session) => atContinue.continuedStep(this.context.store, run, session),
      beforeFinalStep: run => workflowPosition.waitingBeforeFinalWorkflowStep(run, (record, step) => this.host.isSyntheticContinuation(record, step), record => this.waitingWorkflowStepIndex(record)),
      waitingStepIndex: run => this.waitingWorkflowStepIndex(run),
      pendingFallback: () => this.workerQuestions.pendingWorkerFallback(runId),
      pendingAsk: () => hasPendingHumanAsk(runId, id => pendingHumanAskSeq(this.context.store.transcriptFacts, id)),
      rootFinishing: run => this.host.executionBlockedByRootFinish(run),
      answeredElsewhere: () => this.workerQuestions.answeredElsewhere(runId),
      ciStepIndex: run => workflowPosition.ciWorkflowResumeStepIndex(run),
      untouched: run => this.host.isUntouchedCancelledRun(run),
      sessionId: step => workflowPosition.resumableSessionId(this.context.store, runId, step),
    }, this.routedQuestionRefusal, this.context.home).prepare();
    if (!admitted.ok) return admitted;
    return this.acceptContinuation(runId, opts, deferForCapacity, conversation, admitted);
  }

  /** Overrides still persist before the execution checkpoint, even if that checkpoint refuses. */
  private acceptContinuation(runId: string, opts: ContinueRunOptions, deferForCapacity: boolean,
    conversation: continuation.ContinuationConversation, admitted: continuation.ContinuationAdmission): continuation.ContinuationResult {
    const workerOverride = this.prepareWorkerOverride(runId, opts, admitted);
    if (workerOverride && 'ok' in workerOverride) return workerOverride;
    if (admitted.identity === undefined && continuation.hasOverrides(opts)) {
      const refusal = continuation.modelRefusal(opts, admitted.targetRunner);
      if (refusal) return refusal;
      this.context.store.updateRun(runId, continuation.overridePatch(admitted.run, opts, admitted.targetRunner, admitted.originalRunner));
    }
    if (admitted.untouched) return this.acceptUntouchedContinuation(runId, opts, admitted.supersedes, workerOverride);
    return this.acceptResumedContinuation(runId, opts, deferForCapacity, conversation, admitted, workerOverride);
  }

  private prepareWorkerOverride(
    runId: string,
    opts: ContinueRunOptions,
    admitted: continuation.ContinuationAdmission,
  ): WorkerIdentityOverride | continuation.ContinuationRefusal | undefined {
    if (admitted.identity === undefined || (opts.model === undefined && opts.effort === undefined)) return undefined;
    const modelError = continuation.modelRefusal(opts, admitted.targetRunner);
    if (modelError) return modelError;
    const effort = continuation.normalizeWorkerOverrideEffort(opts.effort);
    if (!effort.ok) return effort;
    const raw = readWorkerIdentity(this.context.store.workerExecutions, runId);
    if (raw?.kind !== 'accepted') return undefined;
    const previous = resolveWorkerIdentity(admitted.run, raw);
    const model = opts.model === undefined ? undefined : opts.model.trim();
    const patched = patchWorkerIdentity(admitted.run, previous, admitted.identityStepId, { model, effort: effort.value });
    return patched ? { previous, next: patched.identity, pending: patched.pending, runPatch: patched.runPatch } : undefined;
  }

  private acceptUntouchedContinuation(runId: string, opts: ContinueRunOptions, supersedes: boolean, workerOverride?: WorkerIdentityOverride): continuation.ContinuationResult {
    const current = this.context.store.getRun(runId)!;
    let job: { workflow: WorkflowDef; input: StartRunInput };
    let identityStaged = false;
    try {
      if (workerOverride) {
        this.context.store.workerExecutions.updateWorkerIdentity(runId, { ...workerOverride.previous, pending: workerOverride.pending });
        identityStaged = true;
      }
      // Build the job from a detached projection so a checkpoint refusal leaves the held RunRecord untouched.
      const projected = workerOverride ? { ...current, ...workerOverride.runPatch, status: 'queued' as const } : { ...current, status: 'queued' as const };
      job = current.delegation?.role === 'worker'
        ? this.host.ownedJob(projected)
        : { workflow: atContinue.storedWorkflow(current)!, input: atTaskHead.recoveryInput(current) };
      this.workerExecutions.beginWorkerExecution(runId, false);
    } catch (error) {
      if (identityStaged && workerOverride) this.finalizeWorkerIdentity(runId, workerOverride.previous);
      return admissionRefusal(error, 'original execution checkpoint unavailable');
    }
    if (supersedes) this.workerQuestions.supersedeWorkerFallback(runId);
    const content = continuation.content(opts);
    const message = content.length ? this.queuedInput.toQueuedMessage(runId, content) : undefined;
    this.autoResumeScheduler.clearAutoResume(runId);
    this.context.store.archive.setArchived(runId, false);
    this.host.move(runId, 'continue-line', {
      ...(workerOverride ? workerOverride.runPatch : {}),
      stopping: undefined,
      ...(message ? { queuedMessages: [...(current.queuedMessages ?? []), message] } : {}),
    });
    this.context.store.persistence.flush();
    if (workerOverride) this.finalizeWorkerIdentity(runId, workerOverride.next);
    this.line.enqueueJob(runId, job);
    void this.host.pump();
    return { ok: true };
  }

  private finalizeWorkerIdentity(runId: string, identity: AcceptedWorkerIdentity): void {
    try {
      this.context.store.workerExecutions.updateWorkerIdentity(runId, identity);
    } catch { /* best-effort; crash-recovery pending reconciles against runs.db on read */ }
  }

  private acceptResumedContinuation(runId: string, opts: ContinueRunOptions, deferForCapacity: boolean,
    conversation: continuation.ContinuationConversation, admitted: continuation.ContinuationAdmission, workerOverride?: WorkerIdentityOverride): continuation.ContinuationResult {
    const { run, supersedes } = admitted;
    // Usage-limit holds join the line even for a human Continue, behind known account deadlines.
    const toLine = deferForCapacity || isUsageLimitHold(run);
    try { this.workerExecutions.beginWorkerExecution(runId, !toLine); }
    catch (error) { return admissionRefusal(error, 'worker execution checkpoint unavailable'); }
    this.autoResumeScheduler.clearAutoResume(runId);
    if (!deferForCapacity) this.host.clearWakeBackoff(runId);
    const failure = continuation.previousFailure(run);
    const continuationStep = continuation.nextStep(run, admitted.continuedStep);
    const stepId = continuationStep.id;
    if (run.delegation?.role !== 'worker') this.context.store.addStep(runId, continuationStep);
    const recovered = deferForCapacity && !conversation && !opts.answerInputId ? atContinue.checkpoint(run) : undefined;
    const message = recovered ?? this.queuedInput.toQueuedMessage(runId, continuation.content(opts));
    const opened = continuation.opening(message, recovered, deferForCapacity, conversation, opts,
      this.restartContinuationPrompt, failure);
    const prompt = opened.prompt;
    // A first interrupted turn has no checkpoint to carry the cut-off work (hearsay-tools/squawk#3909).
    const resumeContext = opened.resumeContext && withCutOff(this.context.store, runId, opened.resumeContext);
    // The recoverable status and original input must commit before startup can await anything.
    const acceptedPatch = {
      ...(workerOverride ? workerOverride.runPatch : {}),
      continuationMessage: continuation.acceptedMessage(message, stepId, prompt, resumeContext, recovered, conversation, opts, deferForCapacity, run.task),
      ...(!opts.providerRetry && run.autoResumeReason !== undefined ? { autoResumeReason: undefined } : {}),
      ...(toLine ? {} : { currentStepId: stepId }),
      invalidAsk: undefined,
      archived: false,
      archivedAt: undefined,
    };
    const refusal = this.checkpointContinuation(runId, run, toLine ? 'continue-line' : 'continue-now', acceptedPatch, continuationStep, conversation, workerOverride);
    if (refusal) return refusal;
    if (supersedes) this.workerQuestions.supersedeWorkerFallback(runId);
    // Resolve waits/restart budgets only with or after the dependent answer (hearsay-tools/cezarion#1805).
    this.commitContinuation(runId, !deferForCapacity);
    this.continuationGenerations.set(runId, Symbol());
    const images = contentBlocksOf(opts.images ?? []).filter(block => block.type === 'image');
    return this.dispatchAcceptedContinuation(runId, toLine, stepId, admitted.resumeSessionId, admitted.targetRunner, prompt, images);
  }

  private checkpointContinuation(runId: string, run: RunRecord, exit: 'continue-line' | 'continue-now',
    acceptedPatch: Parameters<RunWrites['commitWorkerContinuation']>[2],
    continuationStep: Parameters<RunWrites['commitWorkerContinuation']>[3],
    conversation: continuation.ContinuationConversation,
    workerOverride?: WorkerIdentityOverride): continuation.ContinuationRefusal | undefined {
    if (run.delegation?.role === 'worker') {
      let identityStaged = false;
      try {
        if (workerOverride) {
          this.context.store.workerExecutions.updateWorkerIdentity(runId, { ...workerOverride.previous, pending: workerOverride.pending });
          identityStaged = true;
        }
        this.context.store.commitWorkerContinuation(runId, exit, acceptedPatch, continuationStep, conversation);
      }
      catch (error) {
        if (identityStaged && workerOverride) this.finalizeWorkerIdentity(runId, workerOverride.previous);
        // No session exists yet. Release the private reservation through execution finalization.
        void this.host.finishWorkerExecution(runId);
        const cause = error instanceof Error && error.message ? error.message : String(error);
        console.warn(`[hsq] worker ${runId} continuation was not saved: ${cause}`);
        return { ok: false, error: `the resume could not be saved (${cause})`, next: 'retry the same command' };
      }
      if (workerOverride) this.finalizeWorkerIdentity(runId, workerOverride.next);
    } else this.context.store.move(runId, exit, acceptedPatch);
  }

  private dispatchAcceptedContinuation(runId: string, toLine: boolean, stepId: string,
    resumeSessionId: string | undefined, targetRunner: string, prompt: string, images: PastedContent[]): { ok: boolean } {
    if (toLine) {
      this.line.enqueueContinuation(runId, {
        stepId, sessionId: resumeSessionId, backend: targetRunner, prompt, images, lineJoinedAt: Date.now(),
      });
      // `checkpointContinuation` already wrote continue-line (Table B7).
      // Enqueueing wakes the scheduler even after the previous execution released its slot.
      void this.host.pump();
      return { ok: true };
    }
    this.line.markStarting(runId);
    void this.context.work.track('runContinuation', this.host.runContinuation(runId, stepId, resumeSessionId, targetRunner, prompt, images))
      .catch((err: unknown) => this.failCrashedContinuation(runId, err))
      .finally(() => this.host.finishWorkerExecution(runId));
    return { ok: true };
  }

  /** A Continue whose engine threw: the run fails and leaves the active set (exit `fail-crash`). */
  failCrashedContinuation(runId: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.host.move(runId, 'fail-crash', { error: `continue crashed: ${message}` });
    this.line.unmarkStarting(runId);
    this.host.dropActive(runId);
  }

  private waitingWorkflowStepIndex(run: RunRecord): number {
    return workflowPosition.waitingWorkflowStepIndex(run, (record, step) => this.host.isSyntheticContinuation(record, step), workflowPosition.ciWorkflowResumeStepIndex);
  }
}
