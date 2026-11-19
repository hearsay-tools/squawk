import { vi } from 'vitest';
import { testHome } from '../home/test-home.testkit.ts';
import type { RunStore } from '../runs/store.ts';
import type { ContinuationResult, ContinueRunOptions } from './continuation-admission.ts';
import { RESTART_CONTINUATION_PROMPT, ROUTED_QUESTION_REFUSAL } from './run/constants.ts';
import { ContinuationAcceptance } from './run/continuation-acceptance.ts';
import * as launchContext from './run/launch-context.ts';
import { QueuedInput } from './run/queued-input.ts';
import { isUntouchedCancelledRun } from './run/run-guards.ts';
import { TrackedWork } from './run/tracked-work.ts';
import type { RunModuleContext } from './run/types.ts';
import { isSyntheticContinuation } from './run/workflow-position.ts';
import { unused } from './unused.testkit.ts';

type Args = ConstructorParameters<typeof ContinuationAcceptance>;

/**
 * `ContinuationAcceptance` over a real store and no engine, wired as `RunManager` composes it:
 * no run is active, claimed or finishing, and the line and the session launch are spies.
 * Any other collaborator read throws.
 */
export function acceptanceOver(store: RunStore, repoRoot: string): {
  acceptance: ContinuationAcceptance;
  continueRun: (runId: string, opts?: ContinueRunOptions, defer?: boolean) => ContinuationResult;
} {
  const context = unused<RunModuleContext>('RunModuleContext', {
    store, repoRoot, home: testHome(), work: new TrackedWork(), disposed: () => false,
  });
  const host = unused<Args[1]>('ContinuationAcceptance.host', {
    isActive: () => false,
    move: (id, exit, patch) => store.move(id, exit, patch),
    executionBlockedByRootFinish: () => false,
    finishWorkerExecution: vi.fn<Args[1]['finishWorkerExecution']>(async () => undefined),
    clearWakeBackoff: vi.fn(),
    pump: vi.fn<Args[1]['pump']>(async () => undefined),
    runContinuation: vi.fn<Args[1]['runContinuation']>(async () => undefined),
    workerStep: (id, step) => launchContext.workerStep(context, id, step),
    isUntouchedCancelledRun: run => isUntouchedCancelledRun(run),
    isSyntheticContinuation: (run, step) => isSyntheticContinuation(run, step),
  });
  const claims = unused<Args[2]>('MaintenanceClaims', { autosaveStartBlocker: () => undefined, blocksStart: () => false });
  const line = unused<Args[3]>('RunLine', { enqueueJob: vi.fn(), enqueueContinuation: vi.fn(), markStarting: vi.fn(), unmarkStarting: vi.fn() });
  const workerExecutions = unused<Args[4]>('WorkerExecutions', { beginWorkerExecution: vi.fn() });
  const queuedInput = new QueuedInput(context, unused<ConstructorParameters<typeof QueuedInput>[1]>('QueuedInput.host', { persistPastedAttachments: () => [] }), unused('RunMemory'));
  const autoResume = unused<Args[6]>('AutoResumeScheduler', { clearAutoResume: vi.fn() });
  const workerQuestions = unused<Args[8]>('WorkerQuestions', {
    pendingWorkerFallback: () => false, answeredElsewhere: () => false, supersedeWorkerFallback: () => false,
  });
  const acceptance = new ContinuationAcceptance(context, host, claims, line, workerExecutions, queuedInput, autoResume,
    unused('WorktreeAutosave'), workerQuestions, ROUTED_QUESTION_REFUSAL, RESTART_CONTINUATION_PROMPT);
  /** `RunManager.continueRun` past its ownership hold, which these tests never contend. */
  const continueRun = (runId: string, opts: ContinueRunOptions = {}, defer = false) =>
    acceptance.admitContinuation(runId, opts, defer, undefined);
  return { acceptance, continueRun };
}
