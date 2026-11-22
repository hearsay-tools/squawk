import { latestSessionStep } from '@open-mercato/cezar-contract/run-predicates';
import { removedRunnerMessage } from '@open-mercato/cezar-contract/runner';
import { atTaskHead, atContinue } from './launch-read-resolver.ts';
import type { WorkerStepIdentity } from '../../delegation/execution-identity.ts';
import type { RunRecord, QueuedMessage } from '../../runs/store.ts';
import type { RunPatchInput } from '../../runs/ports.ts';
import { queuedStartAt } from '../run-scheduling.ts';
import type { RunExitId } from '../../runs/run-exits.ts';
import { stepKind, type WorkflowDef } from '../types.ts';
import type { PastedContent } from '../pasted-content.ts';
import type { PendingJob } from './run-line.ts';
import type { RunModuleContext, PendingContinuation, StartRunInput } from './types.ts';
import { withCutOff } from './cut-off-work.ts';
import { waitsForUnregisteredRunner } from '../../runs/legacy-run-rows.ts';

export interface QueuedRevivalHost {
  move(runId: string, exit: RunExitId, patch?: Omit<RunPatchInput, 'status'>): RunRecord | undefined;
  isActive(runId: string): boolean;
  workerExecutionStopped(runId: string): boolean;
  ownedJob(run: RunRecord): PendingJob;
  resumableSessionId(runId: string, step: RunRecord['steps'][number] | undefined): string | undefined;
  workerStep(runId: string, stepId: string | undefined): WorkerStepIdentity | undefined;
  toQueuedMessage(runId: string, content: PastedContent[]): QueuedMessage;
  hydrateQueuedInput(runId: string, input: StartRunInput): StartRunInput;
  enqueueJob(runId: string, job: PendingJob): void;
  enqueueContinuation(runId: string, continuation: PendingContinuation): void;
  isSyntheticContinuation(run: RunRecord, step: RunRecord['steps'][number]): boolean;
  restartContinuationPrompt: string;
  reviveQueuedRun(run: RunRecord, reason: string): Promise<void>;
  reviveWorkflow(run: RunRecord): Promise<WorkflowDef | null>;
  checkpointRestartContext(run: RunRecord, queuedStepId?: string): RunRecord;
}

/** Save restart evidence before queue admission or the next startup await. */
export function checkpointRestartContext(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, queuedStepId?: string): RunRecord {
  const message = atContinue.checkpoint(run) ?? (queuedStepId ? {
    ...host.toQueuedMessage(run.id, []), id: queuedStepId, text: 'Continue.', origin: 'lifecycle' as const,
  } : undefined);
  if (!message) return run;
  const updated = context.store.updateRun(run.id, { continuationMessage: {
    ...message,
    ...(message.origin === 'lifecycle' && message.text === host.restartContinuationPrompt ? { text: 'Continue.' } : {}),
    resumeContext: withCutOff(context.store, run.id, { ...message.resumeContext, restarted: true }),
  } }) ?? run;
  context.store.flush();
  return updated;
}

/**
 * Rebuild executable state for a durable queued record. Shared by recovery and the watchdog;
 * reconstruct jobs or continuations before pumping.
 */
export async function reviveQueuedRun(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, reason: string): Promise<void> {
  if (host.isActive(run.id) || host.workerExecutionStopped(run.id)) return;
  // A task queued on a runner this process did not register stays queued and untouched: a process
  // that registers that runner starts it (hearsay-tools/squawk#3897).
  if (waitsForUnregisteredRunner(run)) return;
  const queuedContinuation = [...run.steps]
    .reverse()
    .find((step) => step.status === 'pending' && host.isSyntheticContinuation(run, step));
  const sessionStep = queuedContinuation
    ? latestSessionStep(run.steps, queuedContinuation.id)
    : undefined;
  // A provider retry or a worker resume with no earlier session queues a fresh-session
  // continuation (hearsay-tools/squawk#3337): it revives as that continuation, never as the job.
  if (queuedContinuation) {
    reviveQueuedContinuation(context, host, run, reason, queuedContinuation.id, sessionStep?.sessionId ? sessionStep : queuedContinuation);
    return;
  }
  // A task queued on a runner Squawk no longer ships has no runner to start on: the project
  // default is no one's choice for it (hearsay-tools/squawk#3715).
  if (run.removedRunner !== undefined) {
    failRemovedRunner(context, host, run.id, run.removedRunner, reason);
    return;
  }
  if (run.delegation?.role === 'worker') {
    reviveQueuedWorker(context, host, run, reason);
    return;
  }
  const workflow = await host.reviveWorkflow(run);
  if (!workflow) {
    host.move(run.id, 'fail-start', { error: 'interrupted — workflow definition not recoverable after a restart' });
    context.store.eventLog.appendEvent(run.id, {
      type: 'lifecycle',
      message: `${reason} — workflow definition not recoverable, task failed`,
    });
    return;
  }
  host.enqueueJob(run.id, {
    workflow,
    startAt: queuedStartAt(run, workflow),
    // Rehydrate again at dequeue so edits and stacked messages keep their admission-time reads.
    input: host.hydrateQueuedInput(run.id, atTaskHead.recoveryInput(run)),
  });
  context.store.eventLog.appendEvent(run.id, { type: 'lifecycle', message: `${reason} — task re-queued` });
}

export function reviveQueuedContinuation(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, reason: string, queuedStepId: string, sessionStep: RunRecord['steps'][number]): void {
  if (reason === 'cezar restarted') run = host.checkpointRestartContext(run, queuedStepId);
  if (run.removedRunner !== undefined) {
    context.store.updateStep(run.id, queuedStepId, { status: 'failed', error: removedRunnerMessage(run.removedRunner), finishedAt: new Date().toISOString() });
    failRemovedRunner(context, host, run.id, run.removedRunner, reason);
    return;
  }
  const { backend, recoveredSessionId } = queuedResumeSession(context, host, run, sessionStep);
  host.enqueueContinuation(run.id, {
    stepId: queuedStepId,
    sessionId: recoveredSessionId,
    backend,
    prompt: atContinue.prompt(run, host.restartContinuationPrompt),
    images: [],
    lineJoinedAt: Date.now(),
  });
  context.store.eventLog.appendEvent(run.id, {
    type: 'lifecycle',
    message: `${reason} — interrupted continuation re-queued`,
  });
}

/** Match the pinned execution account before considering a persisted session resumable. */
export function queuedResumeSession(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, sessionStep: RunRecord['steps'][number]) {
  return atTaskHead.queuedResumeSession(context, host, run, sessionStep);
}

export function reviveQueuedWorker(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, reason: string): void {
  try {
    const job = host.ownedJob(run);
    // Use the privately bound workflow, and the same durable pending-step
    // cursor as root recovery. A queued tail must not replay a failed source.
    host.enqueueJob(run.id, atTaskHead.resumedJob(run, job));
    context.store.eventLog.appendEvent(run.id, { type: 'lifecycle', message: `${reason} — owned task re-queued` });
  } catch (error) {
    host.move(run.id, 'fail-start', { error: String(error) });
  }
}

/** True when the interrupted run has no session to continue and goes back to the queue. */
export function requeueInterruptedRun(context: RunModuleContext, host: QueuedRevivalHost, run: RunRecord, interruptedStepId: RunRecord['currentStepId']): boolean {
  const interruptedIndex = atTaskHead.interruptedIndex(run, interruptedStepId);
  const interruptedDef = atTaskHead.interruptedDefinition(run, interruptedIndex);
  // Worktree setup (hearsay-tools/cezarion#917) interrupted before any agent session: there is no session to
  // continue, so start the workflow over. `execute` sees setup still `running` and reruns it.
  if (atTaskHead.storedWorkflow(run) && run.worktreeSetup?.status === 'running' && !run.steps.some(step => step.sessionId)) {
    host.move(run.id, 'requeue', { error: undefined, finishedAt: undefined });
    context.store.flush();
    host.enqueueJob(run.id, { workflow: atTaskHead.storedWorkflow(run)!, startAt: 0, input: atTaskHead.recoveryInput(run) });
    return true;
  }
  if (atTaskHead.storedWorkflow(run) && interruptedDef && stepKind(interruptedDef) === 'check') {
    context.store.updateStep(run.id, interruptedDef.id, { status: 'pending', error: undefined, finishedAt: undefined });
    host.move(run.id, 'requeue', { error: undefined, finishedAt: undefined });
    context.store.flush();
    host.enqueueJob(run.id, {
      workflow: atTaskHead.storedWorkflow(run)!,
      startAt: interruptedIndex,
      input: atTaskHead.recoveryInput(run),
    });
    return true;
  }
  return false;
}

/** The persisted definition when it looks sane, else the catalog by name. */
export const reviveWorkflow = atTaskHead.reviveWorkflow;

/** Fail a queued task saved on a removed runner before it starts (hearsay-tools/squawk#3715). */
function failRemovedRunner(context: RunModuleContext, host: QueuedRevivalHost, runId: string, removedRunner: string, reason: string): void {
  const error = removedRunnerMessage(removedRunner);
  host.move(runId, 'fail-start', { error, finishedAt: new Date().toISOString() });
  context.store.eventLog.appendEvent(runId, { type: 'lifecycle', message: `${reason} — task failed: ${error}` });
}
