import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS, makeRunRecord, makeStepState } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RunStore } from '../../runs/store.ts';
import { testHome } from '../../home/test-home.testkit.ts';
import { WorkspaceSemaphore } from '../../workspace/semaphore.ts';
import { noRunners } from '../../core/runners-under-test.testkit.ts';
import { TrackedWork } from './tracked-work.ts';
import { reviveQueuedRun, type QueuedRevivalHost } from './queued-revival.ts';
import type { RunModuleContext } from './types.ts';
import { removedRunnerMessage } from '@open-mercato/cezar-contract/runner';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

// hearsay-tools/squawk#3337: a queued fresh-session retry revives as its continuation, never as the job.
it('revives a queued continuation with no earlier session as that continuation', async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-queued-revival-'));
  const store = RunStore.open(root);
  const context = { createRunner: noRunners, home: testHome(), store, dataDir: root, repoRoot: root,
    semaphore: new WorkspaceSemaphore({ home: testHome() }), work: new TrackedWork(), disposed: () => false } as RunModuleContext;
  const steps = [
    makeStepState({ id: 'build', kind: STEP_KIND.agent, status: STEP_STATUS.failed, backend: 'claude' }),
    makeStepState({ id: 'verify', kind: STEP_KIND.agent, status: STEP_STATUS.pending }),
    makeStepState({ id: 'continue-1', kind: STEP_KIND.agent, status: STEP_STATUS.pending, synthetic: 'continuation' }),
  ];
  const created = store.createRun({ title: 'held', task: 'build it', workflow: 'quick-task', steps: [] });
  const run = makeRunRecord({ id: created.id, status: RUN_STATUS.queued, runner: 'codex', steps, workflowCursor: { stepId: 'build', mode: 'resume' as const }, autoResumeReason: 'provider-error',
    continuationMessage: { id: 'continue-1', text: 'A provider error stopped this step. Your instructions: build it', origin: 'lifecycle', createdAt: new Date().toISOString() } });
  const enqueueContinuation = vi.fn(); const enqueueJob = vi.fn();
  const host = { isActive: () => false, workerExecutionStopped: () => false, isSyntheticContinuation: (_run: unknown, step: { synthetic?: string }) => step.synthetic === 'continuation',
    workerStep: () => undefined, resumableSessionId: () => undefined, restartContinuationPrompt: 'Continue.', enqueueContinuation, enqueueJob,
    reviveWorkflow: async () => null } as unknown as QueuedRevivalHost;
  await reviveQueuedRun(context, host, run, 'queue watchdog');
  expect(enqueueJob).not.toHaveBeenCalled();
  expect(enqueueContinuation).toHaveBeenCalledWith(run.id, expect.objectContaining({ stepId: 'continue-1', sessionId: undefined, backend: 'claude',
    prompt: expect.stringContaining('Your instructions: build it') }));
});

// hearsay-tools/squawk#3715: a task queued on a runner Squawk no longer ships has no runner to start on.
it('fails a queued task saved on a removed runner instead of starting it on the project default', async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-queued-revival-'));
  const store = RunStore.open(root);
  const context = { createRunner: noRunners, home: testHome(), store, dataDir: root, repoRoot: root,
    semaphore: new WorkspaceSemaphore({ home: testHome() }), work: new TrackedWork(), disposed: () => false } as RunModuleContext;
  const created = store.createRun({ title: 'queued', task: 'build it', workflow: 'quick-task',
    steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
  const run = makeRunRecord({ id: created.id, status: RUN_STATUS.queued, removedRunner: 'cursor',
    steps: [makeStepState({ id: 'task', kind: STEP_KIND.agent, status: STEP_STATUS.pending })] });
  const enqueueContinuation = vi.fn(); const enqueueJob = vi.fn(); const move = vi.fn();
  const host = { isActive: () => false, workerExecutionStopped: () => false, isSyntheticContinuation: () => false,
    enqueueContinuation, enqueueJob, move, reviveWorkflow: async () => ({ name: 'quick-task', steps: [] }) } as unknown as QueuedRevivalHost;
  await reviveQueuedRun(context, host, run, 'cezar restarted');
  expect(enqueueJob).not.toHaveBeenCalled();
  expect(enqueueContinuation).not.toHaveBeenCalled();
  expect(move).toHaveBeenCalledWith(run.id, 'fail-start', expect.objectContaining({ error: removedRunnerMessage('cursor') }));
});

// hearsay-tools/squawk#3715: a Continue queued after work on a removed runner reopens no older session.
it('revives a continuation queued after a removed-runner step as a new session', async () => {
  root = mkdtempSync(join(tmpdir(), 'cez-queued-revival-'));
  const store = RunStore.open(root);
  const context = { createRunner: noRunners, home: testHome(), store, dataDir: root, repoRoot: root,
    semaphore: new WorkspaceSemaphore({ home: testHome() }), work: new TrackedWork(), disposed: () => false } as RunModuleContext;
  const steps = [
    makeStepState({ id: 'plan', kind: STEP_KIND.agent, status: STEP_STATUS.done, sessionId: 'plan-session', backend: 'claude' }),
    makeStepState({ id: 'build', kind: STEP_KIND.agent, status: STEP_STATUS.done, removedBackend: 'cursor' }),
    makeStepState({ id: 'continue-1', kind: STEP_KIND.agent, status: STEP_STATUS.pending, synthetic: 'continuation', continuesStepId: 'build' }),
  ];
  const created = store.createRun({ title: 'held', task: 'build it', workflow: 'quick-task', steps: [] });
  const run = makeRunRecord({ id: created.id, status: RUN_STATUS.queued, runner: 'claude', steps,
    continuationMessage: { id: 'continue-1', text: 'keep going', origin: 'human', createdAt: new Date().toISOString() } });
  const enqueueContinuation = vi.fn();
  const host = { isActive: () => false, workerExecutionStopped: () => false, isSyntheticContinuation: (_run: unknown, step: { synthetic?: string }) => step.synthetic === 'continuation',
    workerStep: () => undefined, resumableSessionId: () => 'plan-session', restartContinuationPrompt: 'Continue.', enqueueContinuation, enqueueJob: vi.fn(),
    reviveWorkflow: async () => null } as unknown as QueuedRevivalHost;
  await reviveQueuedRun(context, host, run, 'queue watchdog');
  expect(enqueueContinuation).toHaveBeenCalledWith(run.id, expect.objectContaining({ stepId: 'continue-1', sessionId: undefined, backend: 'claude' }));
});
