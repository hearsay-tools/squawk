import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager, fixtureWork, removeFixtureRepo } from './fixture-claude.testkit.ts';
import type { WorkflowDef } from './types.ts';

// `createRunner` is async: the step awaits the adapter's load. A Stop that lands during that load
// ends the step before it selects itself and provisions its tools, as a Stop just before the load
// does; the Continue path rechecks its cancellation before it provisions too.
const workflow: WorkflowDef = { name: 'runner-load-stop', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await removeFixtureRepo(root);
});

it.each(['fresh', 'Continue'] as const)('%s: a Stop during the runner load launches nothing and provisions nothing', async mode => {
  vi.stubEnv('CEZ_DRY_RUN', '1');
  vi.stubEnv('CEZ_AUTONAME', '0');
  const root = mkdtempSync(join(tmpdir(), 'cez-runner-load-stop-'));
  roots.push(root);
  const store = RunStore.open(join(root, '.ai/cezar'));
  let release!: () => void;
  const loaded = new Promise<void>(resolve => { release = resolve; });
  let enterLoad!: () => void;
  const loading = new Promise<void>(resolve => { enterLoad = resolve; });
  const createRunner = vi.fn(async () => { enterLoad(); await loaded; return new ClaudeCliRunner(); });
  const manager = createFixtureManager(store, root, { home: testHome(), createRunner,
    semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 1 } }) });
  const provision = vi.fn(() => ({ env: {}, instructions: '', restrictCrossSessionMessaging: true as const, revoke: () => {} }));
  manager.setDelegationProvisioner(provision);
  const launches = vi.spyOn(ClaudeCliRunner.prototype, 'startSession');
  let id: string;
  if (mode === 'fresh') id = manager.startRun(workflow, { task: 'stop during load', runner: 'claude', worktree: false }).id;
  else {
    const prior = store.createRun({ title: 'resume', task: 'resume', workflow: workflow.name, runner: 'claude',
      steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
    store.updateStep(prior.id, 'task', { status: STEP_STATUS.done, sessionId: 'prior-session', backend: 'claude' });
    setRunStatus(store, prior.id, RUN_STATUS.done, { workflowDef: workflow });
    expect(manager.continueRun(prior.id)).toEqual({ ok: true });
    id = prior.id;
  }
  await loading;
  const stepId = store.getRun(id)!.currentStepId!;
  const label = mode === 'fresh' ? 'execute' : 'runContinuation';
  const completion = [...fixtureWork(manager).pending].find(([, name]) => name === label)?.[0];
  expect(completion).toBeDefined();
  expect(manager.cancel(id)).toBe(true);
  release();
  await completion;
  expect(createRunner).toHaveBeenCalledTimes(1);
  expect(launches).not.toHaveBeenCalled();
  expect(provision).not.toHaveBeenCalled();
  expect(manager.isActive(id)).toBe(false);
  expect(store.getRun(id)).toMatchObject({ status: RUN_STATUS.cancelled });
  expect(store.getRun(id)?.steps.find(step => step.id === stepId)?.status).toBe(STEP_STATUS.cancelled);
});
