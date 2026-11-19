import { chmodSync, existsSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';
import { createRunner } from '../core/runner-registry.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { DelegationService } from './service.ts';
import { workerCleanups } from './worker-cleanup.ts';
import { workerCapacity } from './capacity.ts';
import { cadence, destroyOf, f, input, linux, useDestroyBackoffFixture } from './service-destroy-backoff.testkit.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

registerRunner(claudeRunner);

/** A worker whose launch failed before its first step: settled, failed, with no step started. */
async function failStart(options: { reservedDirectory?: boolean } = {}) {
  const { workerId } = await f.service.spawn(f.caller, input());
  const run = f.store.getRun(workerId)!;
  if (run.delegation?.role !== 'worker') throw new Error('worker');
  // What a `git worktree add` that failed before its rollback existed left behind.
  if (options.reservedDirectory) mkdirSync(run.delegation.workspace.path, { recursive: true });
  const generation = f.store.commitWorkerExecutionStart(workerId);
  setRunStatus(f.store, workerId, RUN_STATUS.failed, { error: 'worktree creation failed: git worktree add failed: fatal: example' });
  expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
  return { workerId, workspace: run.delegation.workspace };
}

describe('a worker that failed before its first step (hearsay-tools/squawk#3817)', { timeout: 60_000 }, () => {
  useDestroyBackoffFixture();

  it.runIf(linux)('is destroyed without being asked, frees its slot and keeps its failure readable', async context => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId } = await f.service.spawn(f.caller, input());
    const run = f.store.getRun(workerId)!;
    if (run.delegation?.role !== 'worker') throw new Error('worker');
    // A read-only worktrees directory: the launch's `mkdir` fails, as a real fail-start does.
    const worktrees = dirname(run.delegation.workspace.path);
    mkdirSync(worktrees, { recursive: true });
    chmodSync(worktrees, 0o555);
    onTestFinished(() => { if (existsSync(worktrees)) chmodSync(worktrees, 0o755); });
    // A process with CAP_DAC_OVERRIDE writes through 0555, and then nothing fails the launch.
    let writable = false;
    try { mkdirSync(join(worktrees, 'probe')); rmdirSync(join(worktrees, 'probe')); writable = true; } catch { /* read-only: the launch fails */ }
    if (writable) context.skip();
    await f.releaseAdmission();
    await vi.waitFor(() => expect(f.store.getRun(workerId)).toMatchObject({ status: RUN_STATUS.failed, error: expect.stringContaining('worktree creation failed') }), { timeout: 15_000 });
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 15_000 });
    expect(workerCapacity(f.store.getRun(f.parent.id)!, id => f.store.getRun(id)).outstanding).toBe(0);
    expect((await f.service.list(f.caller)).workers).toEqual([expect.objectContaining({ workerId, destroyed: true })]);
    expect(await f.service.collect(f.caller, { workerId })).toMatchObject({ outcome: 'destroyed', lastExecutionOutcome: RUN_STATUS.failed });
  });

  it.runIf(linux)('counts an empty reserved directory as absent and removes it', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId, workspace } = await failStart({ reservedDirectory: true });
    await vi.waitFor(() => expect(destroyOf(workerId)).toMatchObject({ phase: 'complete', remaining: [] }), { timeout: 15_000 });
    expect(existsSync(workspace.path)).toBe(false);
  });

  it.runIf(linux)('does not reach the capacity limit through failed spawns alone', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const failed: string[] = [];
    for (let n = 0; n < 32; n++) failed.push((await failStart()).workerId);
    await vi.waitFor(() => { for (const workerId of failed) expect(destroyOf(workerId)?.phase).toBe('complete'); }, { timeout: 45_000 });
    await expect(f.service.spawn(f.caller, input())).resolves.toMatchObject({ workerId: expect.any(String) });
  });

  it.runIf(linux)('leaves a failed worker whose step started for the parent to destroy', async () => {
    await cadence({ fastMs: 200, fastCount: 10, capMs: 2_000 });
    const { workerId } = await f.service.spawn(f.caller, input());
    const generation = f.store.commitWorkerExecutionStart(workerId);
    const run = f.store.getRun(workerId)!;
    f.store.updateStep(workerId, run.steps[0]!.id, { startedAt: new Date().toISOString() });
    setRunStatus(f.store, workerId, RUN_STATUS.failed, { error: 'agent failed' });
    expect(run.steps.length).toBeGreaterThan(0);
    expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
    // Releases run one at a time, in the order they began: once a later fail-start's release has
    // completed, a release of this worker would have run before it.
    const later = await failStart();
    await vi.waitFor(() => expect(destroyOf(later.workerId)?.phase).toBe('complete'), { timeout: 15_000 });
    expect(destroyOf(workerId)).toBeUndefined();
  });

  it.runIf(linux)('is released after a restart when it settled while no cleanup ran', async () => {
    // The default fixture has no cleanup, so nothing releases the worker before the restart.
    const { workerId } = await failStart();
    f.manager.dispose(); f.store.close();
    const reopened = RunStore.open(join(f.root, '.ai/cezar'));
    const manager = new RunManager(reopened, f.root, { acquireCiResources: acquireInertCiResources, createRunner, home: testHome() });
    const service = new DelegationService(workerCleanups({ backoff: { fastMs: 200, fastCount: 10, capMs: 2_000 } }));
    const detach = service.registerProject({ home: testHome(), id: 'reopened', root: f.root, store: reopened, manager });
    try {
      expect(reopened.listRuns().map(run => run.id)).not.toContain(workerId);
      service.armDestroyRetries('reopened');
      await vi.waitFor(() => expect(reopened.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'complete', remaining: [] } }), { timeout: 15_000 });
    } finally { detach(); manager.dispose(); reopened.flush(); reopened.close(); }
  });

  it.runIf(linux)('does not destroy a worker that was resumed and failed again while its release waited', async () => {
    await cadence({ fastMs: 60_000, fastCount: 10, capMs: 60_000 });
    const serialized = Reflect.get(f.service, 'serialized') as <T>(key: string, operation: () => Promise<T>) => Promise<T>;
    const keys = vi.spyOn(f.service as unknown as { serialized: typeof serialized }, 'serialized');
    let release!: () => void;
    const held = serialized.call(f.service, 'destroy-retries:project', () => new Promise<void>(resolve => { release = resolve; }));
    const { workerId } = await failStart();
    // The release saw a failed start and now waits its turn for a destroy attempt.
    await vi.waitFor(() => expect(keys.mock.calls.filter(([key]) => key === 'destroy-retries:project')).toHaveLength(1), { timeout: 15_000 });
    // Meanwhile the parent resumed it: a step started, and it failed again.
    const run = f.store.getRun(workerId)!;
    f.store.updateStep(workerId, run.steps[0]!.id, { startedAt: new Date().toISOString() });
    release(); await held;
    // Queued behind the release on the same key, so it runs once the release has finished.
    await serialized.call(f.service, 'destroy-retries:project', async () => undefined);
    expect(destroyOf(workerId)).toBeUndefined();
  });
});
