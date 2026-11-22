// Its fixtures delete, reclaim or archive runs, or start worker executions: the shipped removal slots.
import '../built-in-run-slots.testkit.ts';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { testHome } from '../home/test-home.testkit.ts';
import { workerDestroyView } from '../runs/delegation-state.ts';
import { openTestRunStore } from '../runs/run-store-open.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { unused } from '../workflows/unused.testkit.ts';
import type { DelegationExecutionSettings } from '../workflows/run/types.ts';
import { CredentialRegistry, type Caller } from './credentials.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { DelegationService, type DelegationManager, type WorkerCleanupFactory } from './service.ts';
import { workerCleanups } from './worker-cleanup.ts';
import { ensureOwnedWorkspace } from './workspace.ts';

/**
 * The destroy path of `DelegationService` over a real store, Git repository and `workerCleanups`,
 * with a fake manager in place of the run engine. Every worker here is settled with a complete
 * execution and no live session, so the fake answers as the engine does for such a worker.
 */
export type HolderFixture = { root: string; store: RunStore; manager: DelegationManager; parent: RunRecord; caller: Caller; service: DelegationService; close(): void };

// The worker's account binding names its runner, so spawn reads the runner definitions.
registerRunner(claudeRunner);

export let f: HolderFixture;

export const linux = process.platform === 'linux';

/** The parent's execution settings, as the engine fixture pins them. */
function parentSettings(root: string): DelegationExecutionSettings {
  return { cwd: root, runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default',
    accountBinding: { provider: 'claude', profileId: 'default', homePath: root, claudeLayout: { kind: 'relocated' } } };
}

/** The manager calls a settled worker's spawn and destroy make, answered as the engine answers for
 *  a worker with no live execution. Any other call fails the test. */
export function fakeManager(store: RunStore, root: string): DelegationManager {
  return unused<DelegationManager>('manager', {
    // The spawn names no backend, model or effort: the worker inherits the parent's settings.
    selectDelegationExecutionSettings: async (_runId, _selection, validateModel) => {
      const settings = parentSettings(root);
      await validateModel?.(settings);
      return settings;
    },
    enqueueOwnedRun: () => {},
    setWorkerWorkspaces: () => {},
    pauseWorkerCleanup: () => {},
    reconcileWorkerWaits: () => {},
    isActive: () => false,
    requestWorkerStop: workerId => ({ workerId, state: 'terminated' }),
    awaitRunTermination: async workerId => store.readWorkerExecution(workerId)?.phase === 'complete',
    claimWorkerCleanup: () => () => {},
    previewHost: undefined,
  });
}

function initRepository(root: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
  execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
}

export function fixture(cleanup: WorkerCleanupFactory = workerCleanups()): HolderFixture {
  const root = mkdtempSync(join(tmpdir(), 'cez-destroy-holder-'));
  initRepository(root);
  const store = openTestRunStore(join(root, '.ai/cezar'), { keepLive: true });
  const manager = fakeManager(store, root);
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', runner: 'claude', model: 'opus', effort: 'high', steps: [] });
  setRunStatus(store, parent.id, RUN_STATUS.running, { worktreePath: root, delegation: { role: 'root', permissions: ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'], receipts: [] } });
  const credentials = new CredentialRegistry();
  const caller = credentials.authenticate(credentials.issue('project', parent.id, randomUUID()))!;
  const service = new DelegationService(cleanup);
  const unregister = service.registerProject({ home: testHome(), id: 'project', root, store, manager });
  return { root, store, manager, parent, caller, service, close() {
    unregister(); credentials.close(); store.close(); rmSync(root, { recursive: true, force: true });
  } };
}

/** Each fixture receives its test cadence at construction; an explicit destroy waits `manualLockWaitMs` for the lock. */
export const cadence = async (backoff = { fastMs: 40, fastCount: 3, capMs: 300 }, attention = 5, manualLockWaitMs = 500) => {
  f.close();
  f = fixture(workerCleanups({ backoff, attentionAttempts: attention, manualLockWaitMs }));
};

/** A settled worker with a real worktree and complete execution, optionally blocked by a Git worktree
 * lock: Git refuses the removal, so the destroy stays incomplete and is retried until `release()`. */
export async function settled(block = true) {
  const { workerId } = await f.service.spawn(f.caller, { task: 'do work', baseline: 'parent-head', requestId: randomUUID() });
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

/** Runs `read` while no destroy attempt for the worker runs: a read queued on the worker's
 * serialization key sees the state between two attempts, never an attempt's in-progress phase. */
export function betweenAttempts<T>(workerId: string, read: () => T): Promise<T> {
  const serialized = Reflect.get(f.service, 'serialized') as (key: string, operation: () => Promise<T>) => Promise<T>;
  return serialized.call(f.service, `worker:project:${workerId}`, async () => read());
}

export function useHolderFixture(): void {
  beforeEach(() => { scopeFixtureProcesses(); f = fixture(); });
  afterEach(() => { f?.close(); vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs(); });
}
