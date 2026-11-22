// Its fixtures delete, reclaim or archive runs, or start worker executions: the shipped removal slots.
import '../built-in-run-slots.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';

import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';

import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, vi } from 'vitest';

import { fixture } from './service.testkit.ts';
import type { fixture as engineFixture } from './service-engine.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';

import { workerDestroyView } from '../runs/delegation-state.ts';
import { workerCleanups } from './worker-cleanup.ts';
import type { DelegationService, WorkerCleanupFactory } from './service.ts';

/** The fixture a backoff test builds: `FakeRunManager` by default, the engine's when a test passes it. */
type BackoffFixture = ReturnType<typeof fixture> | ReturnType<typeof engineFixture>;
type BuildFixture = (cleanup?: WorkerCleanupFactory) => BackoffFixture;

export let f: BackoffFixture;
let build: BuildFixture = fixture;

export const linux = process.platform === 'linux';

export const input = () => ({ task: 'do work', baseline: 'parent-head', requestId: randomUUID() });

/** Each fixture receives its test cadence at construction; an explicit destroy waits `manualLockWaitMs` for the lock. */
export const cadence = async (backoff = { fastMs: 40, fastCount: 3, capMs: 300 }, attention = 5, manualLockWaitMs = 500) => {
    await f.close();
    f = build(workerCleanups({ backoff, attentionAttempts: attention, manualLockWaitMs }));
  };

/** A settled worker with a real worktree and complete execution, optionally blocked by a Git worktree
 * lock: Git refuses the removal, so the destroy stays incomplete and is retried until `release()`. */
export async function settled(block = true) {
    const { workerId } = await f.service.spawn(f.caller, input());
    const generation = f.store.workerExecutions.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, f.store.getRun(workerId)!);
    setRunStatus(f.store, workerId, RUN_STATUS.review, { worktreePath: workspace.path, branch: workspace.branch });
    expect(f.store.workerExecutions.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
    if (block) execFileSync('git', ['worktree', 'lock', workspace.path], { cwd: f.root });
    const blocker = block ? { release: () => execFileSync('git', ['worktree', 'unlock', workspace.path], { cwd: f.root }) } : undefined;
    return { workerId, workspace, blocker };
  }

/** The destroy as the API shows it: the stored phase plus the run's retry state. */
export const destroyOf = (workerId: string) => { const run = f.store.getRun(workerId); return run ? workerDestroyView(run) : undefined; };

/** Runs `read` while no destroy attempt for the worker runs. Every attempt, explicit or scheduled,
 * holds the worker's serialization key from its first write (`requested`) to its retry record, so a
 * read queued on that key sees the state between two attempts, never an attempt's in-progress phase. */
export function betweenAttempts<T>(workerId: string, read: () => T, service: DelegationService = f.service): Promise<T> {
  const serialized = Reflect.get(service, 'serialized') as (key: string, operation: () => Promise<T>) => Promise<T>;
  return serialized.call(service, `worker:project:${workerId}`, async () => read());
}

/** Builds `f` before each test, on `FakeRunManager` unless the test file passes the engine fixture. */
export function useDestroyBackoffFixture(builder: BuildFixture = fixture) {
  beforeEach(() => { build = builder; scopeFixtureProcesses(); f = build(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });
}
