import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STEP_KIND, STEP_STATUS, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { registerStepKind, registerBuiltInStepKinds, sealStepKinds } from './step-kind-registry.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { loadWorkflows } from './load.ts';

sealTestRunners();
let attempts = 0;
registerStepKind({
  kind: 'fixture-deploy', requiresRunner: false,
  validate(step) { if (step.config?.target !== 'dev') throw new Error('target must be dev'); },
  async execute({ step, emit }) {
    attempts++;
    const output = `deploy ${step.config?.target}: attempt ${attempts}`;
    emit({ type: 'note', stepId: step.id, message: output });
    return { kind: 'result', ok: attempts > Number(step.config?.failures ?? 1), output };
  },
});
registerBuiltInStepKinds();
sealStepKinds();
// Import the engine testkit after custom registration, before it seals the shipped kinds.
const { createFixtureManager, drainFixtureManagers, fixtureWorkSettled } = await import('./fixture-no-runner.testkit.ts');
const { RunStore } = await import('../runs/store.ts');
const roots: string[] = [];
beforeEach(() => { attempts = 0; });
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) { await drainFixtureManagers(root); rmSync(root, { recursive: true, force: true }); }
});

function fixture(pluginKind = 'fixture-deploy', target = 'dev', failures = 1) {
  const root = mkdtempSync(join(tmpdir(), 'plugin-step-'));
  roots.push(root);
  const dir = join(root, '.ai/squawk/workflows');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'deploy.yaml'), `name: deploy
steps:
  - id: prepare
    command: echo prepared
  - id: deploy
    kind: plugin
    pluginKind: ${pluginKind}
    config: { target: ${target}, failures: ${failures} }
    onFail: { retry: prepare, max: 1 }
`);
  return root;
}

it('loads and executes a registered plugin through StepLoop, including a backwards retry', async () => {
  vi.stubEnv('CEZ_AUTONAME', '0');
  const root = fixture();
  const loaded = await loadWorkflows(root);
  expect(loaded.issues).toEqual([]);
  const workflow = loaded.workflows.find(w => w.name === 'deploy')!;
  const store = RunStore.open(join(root, '.ai/squawk'));
  const manager = createFixtureManager(store, root);
  const run = manager.startRun(workflow, { task: 'deploy', worktree: false });
  await fixtureWorkSettled(root);
  const record = store.getRun(run.id)!;
  expect(record.status).toBe(RUN_STATUS.done);
  expect(record.steps[0]).toMatchObject({ iterations: 2, status: STEP_STATUS.done });
  expect(record.steps[1]).toMatchObject({ kind: STEP_KIND.plugin, pluginKind: 'fixture-deploy', iterations: 2, retriesUsed: 1, status: STEP_STATUS.done });
  const events = store.eventLog.readEvents(run.id);
  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ message: 'deploy dev: attempt 1' }),
    expect.objectContaining({ message: 'deploy dev: attempt 2' }),
  ]));
});

it.each([['missing', 'dev', /Unknown workflow step kind/], ['fixture-deploy', 'prod', /target must be dev/]])('reports invalid plugin workflow %s %s', async (kind, target, message) => {
  const loaded = await loadWorkflows(fixture(kind, target));
  expect(loaded.workflows.some(w => w.name === 'deploy')).toBe(false);
  expect(loaded.issues[0]?.message).toMatch(message);
});

it('stops a failing plugin at its authored retry limit', async () => {
  vi.stubEnv('CEZ_AUTONAME', '0');
  const root = fixture('fixture-deploy', 'dev', 99);
  const workflow = (await loadWorkflows(root)).workflows.find(w => w.name === 'deploy')!;
  const store = RunStore.open(join(root, '.ai/squawk'));
  const manager = createFixtureManager(store, root);
  const run = manager.startRun(workflow, { task: 'deploy', worktree: false });
  await fixtureWorkSettled(root);
  const record = store.getRun(run.id)!;
  expect(record.status).toBe(RUN_STATUS.failed);
  expect(record.steps[1]).toMatchObject({ status: STEP_STATUS.failed, retriesUsed: 1, iterations: 2 });
  expect(record.error).toContain('plugin fixture-deploy');
  expect(record.error).not.toContain('undefined');
});
