import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';

import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';

import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, expect, vi } from 'vitest';

import { fixture } from './service.testkit.ts';
import { ensureOwnedWorkspace } from './workspace.ts';

import { workerDestroyView } from '../runs/delegation-state.ts';
import { workerCleanups } from './worker-cleanup.ts';

export let f: ReturnType<typeof fixture>;

export const linux = process.platform === 'linux';

export const input = () => ({ task: 'do work', baseline: 'parent-head', requestId: randomUUID() });

/** Each fixture receives its test cadence at construction. */
export const cadence = async (backoff = { fastMs: 40, fastCount: 3, capMs: 300 }, attention = 5) => {
    await f.close();
    f = fixture(workerCleanups({ backoff, attentionAttempts: attention }));
  };

/** A settled worker with a real worktree and complete execution, optionally blocked by a Git worktree
 * lock: Git refuses the removal, so the destroy stays incomplete and is retried until `release()`. */
export async function settled(block = true) {
    const { workerId } = await f.service.spawn(f.caller, input());
    const generation = f.store.commitWorkerExecutionStart(workerId);
    const workspace = await ensureOwnedWorkspace(f.root, f.store.getRun(workerId)!);
    setRunStatus(f.store, workerId, RUN_STATUS.review, { worktreePath: workspace.path, branch: workspace.branch });
    expect(f.store.commitWorkerExecutionComplete(workerId, generation)).toBe(true);
    if (block) execFileSync('git', ['worktree', 'lock', workspace.path], { cwd: f.root });
    const blocker = block ? { release: () => execFileSync('git', ['worktree', 'unlock', workspace.path], { cwd: f.root }) } : undefined;
    return { workerId, workspace, blocker };
  }

/** The destroy as the API shows it: the stored phase plus the run's retry state. */
export const destroyOf = (workerId: string) => { const run = f.store.getRun(workerId); return run ? workerDestroyView(run) : undefined; };

/** Runs `read` while no destroy attempt for the worker runs. Every attempt, explicit or scheduled,
 * holds the worker's serialization key from its first write (`requested`) to its retry record, so a
 * read queued on that key sees the state between two attempts, never an attempt's in-progress phase. */
export function betweenAttempts<T>(workerId: string, read: () => T): Promise<T> {
  const serialized = Reflect.get(f.service, 'serialized') as (key: string, operation: () => Promise<T>) => Promise<T>;
  return serialized.call(f.service, `worker:project:${workerId}`, async () => read());
}

export function useDestroyBackoffFixture() {
  beforeEach(() => { scopeFixtureProcesses(); f = fixture(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });
}
