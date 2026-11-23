import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import '../runners/claude/claude-runner.testkit.ts';
import { fixedSkillCatalog } from '../core/runner-skill-fixture.testkit.ts';
import { runnersUnderTest } from '../core/runners-under-test.testkit.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { RunManager } from './run.ts';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { RunStore } from '../runs/store.ts';
import { createOwnedWorkspace, planOwnedWorkspace } from '../delegation/workspace.ts';
import { durableRun, fixture, git, managers, WORKSPACE_TEST_TIMEOUT_MS } from '../delegation/workspace-fixture.testkit.ts';
// Its runs are deleted, reclaimed or archived, or start worker executions: the shipped removal slots.
import '../built-in-run-slots.testkit.ts';
sealTestRunners();

const NO_PORT = 'Worker workspaces are unavailable: no worker workspace port is registered';

async function finished(store: RunStore, id: string) {
  await vi.waitFor(() => {
    expect(['done', 'review', 'failed', 'cancelled']).toContain(store.getRun(id)?.status);
    expect(managers.some(manager => manager.isActive(id))).toBe(false);
  }, { timeout: 10_000, interval: 20 }); // bound: a hang guard; the run's terminal status is the signal
}

/** A manager no project registered: nothing gave it a worker workspace port. */
function managerWithoutPort(store: RunStore, root: string) {
  const manager = new RunManager(store, root, { skillCatalog: fixedSkillCatalog(), home: testHome(), createRunner: backend => runnersUnderTest()(backend), acquireCiResources: acquireInertCiResources });
  managers.push(manager);
  return manager;
}

describe('a worker run with no registered worker workspace port', { timeout: WORKSPACE_TEST_TIMEOUT_MS }, () => {
  it('fails its launch and gets no worktree, its own or an ordinary task one', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const { root, second } = await fixture();
    const worktreesBefore = git(root, 'worktree', 'list', '--porcelain');
    const workspace = await planOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    store.updateRun(run.id, { task: 'mock:cezar-done', runner: 'claude' });
    managerWithoutPort(store, root).enqueueOwnedRun(run.id);
    await finished(store, run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: RUN_STATUS.failed, error: `worktree creation failed: ${NO_PORT}` });
    expect(store.getRun(run.id)?.worktreePath).toBeUndefined();
    expect(store.eventLog.readEvents(run.id).some(event => event.type === 'step-start')).toBe(false);
    expect(existsSync(workspace.path)).toBe(false);
    expect(git(root, 'worktree', 'list', '--porcelain')).toBe(worktreesBefore);
  });

  it('fails its Continue before a session starts, with its workspace intact', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    const { root, second } = await fixture();
    const workspace = await createOwnedWorkspace(root, randomUUID(), second);
    const { run, store } = durableRun(root, workspace);
    setRunStatus(store, run.id, RUN_STATUS.done, { runner: 'claude', worktreePath: workspace.path, branch: workspace.branch, baseBranch: second });
    store.updateStep(run.id, 'task', { status: STEP_STATUS.done, sessionId: 'mock-prior-session', backend: 'claude' });
    expect(managerWithoutPort(store, root).continueRun(run.id, { text: 'mock:cezar-done' }).ok).toBe(true);
    await finished(store, run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: RUN_STATUS.failed, error: `owned workspace unavailable: ${NO_PORT}` });
    expect(store.eventLog.readEvents(run.id).some(event => event.type === 'step-start')).toBe(false);
    expect(existsSync(workspace.path)).toBe(true);
  });
});
