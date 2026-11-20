import type { Home } from '../home/home.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { openTestRunStore } from '../runs/run-store-open.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { defaultWorkspaceConfig } from '../workspace/config.ts';
import { createFixtureManager, drainFixtureManagers, managerDisposed } from '../workflows/fixture-claude.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, vi } from 'vitest';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { CredentialRegistry, type Caller } from './credentials.ts';
import { DelegationService, type WorkerCleanupFactory } from './service.ts';
import { copyServiceRepository, removeAfterOwnedWork } from './service.testkit.ts';

/**
 * The delegation fixture on the real run engine with a fake Claude runner, for tests whose assertions need
 * sessions to run: launch, Continue admission, waits that resolve, recovery. `service.testkit.ts` gives every
 * other test the same fixture on `FakeRunManager` (hearsay-tools/squawk#3937).
 */

export async function waitForOwnedWork(manager: RunManager, store: RunStore): Promise<void> {
  // A manager a restart disposed owns nothing any more: the recovered one does (#779).
  if (managerDisposed(manager)) return;
  // Root runs have no worker execution proof; fixture tracking drains those.
  // Every worker id: a manager may still hold a worker whose record already settled (#779).
  for (const id of store.listWorkerIds().filter(id => manager.isActive(id))) {
    manager.cancel(id);
    if (!await manager.awaitRunTermination(id, 8_000)) throw new Error(`Worker did not terminate: ${id}`);
  }
}

export function fixture(cleanup?: WorkerCleanupFactory, home: Home = testHome()): { root: string; sha: string; store: RunStore; manager: RunManager; parent: RunRecord; credentials: CredentialRegistry; caller: Caller; token: string; service: DelegationService; holdAdmission(): Promise<void>; releaseAdmission(): Promise<void>; close(): Promise<void> } {
  const root = mkdtempSync(join(tmpdir(), 'cez-delegation-service-'));
  const sha = copyServiceRepository(root);
  const store = openTestRunStore(join(root, '.ai/cezar'), { keepLive: true });
  // Scheduler admission is held so acceptance is durable before execution starts.
  let admissionHeld = true;
  const semaphore = new WorkspaceSemaphore({ home, initial: { maxParallel: 0 }, load: async () => ({ ...defaultWorkspaceConfig().resources, ...(admissionHeld ? { maxParallel: 0 } : {}) }) });
  const manager = createFixtureManager(store, root, { home, semaphore });
  const admissionReads = vi.spyOn(semaphore, 'maxParallel');
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', runner: 'claude', model: 'opus', effort: 'high', steps: [] });
  setRunStatus(store, parent.id, RUN_STATUS.running, { worktreePath: root, delegation: { role: 'root', permissions: ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'], receipts: [] } });
  const credentials = new CredentialRegistry();
  const token = credentials.issue('project', parent.id, randomUUID());
  const caller = credentials.authenticate(token)!;
  vi.spyOn(manager, 'delegationExecutionSettings').mockReturnValue({ cwd: root, runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default', accountBinding: { provider: 'claude', profileId: 'default', homePath: root, claudeLayout: { kind: 'relocated' } } });
  const service = new DelegationService(cleanup);
  const spawn = service.spawn.bind(service);
  vi.spyOn(service, 'spawn').mockImplementation(async (...args) => {
    const existingWorkers = new Set(store.listWorkerIds());
    const readsBefore = admissionReads.mock.calls.length;
    const result = await spawn(...args);
    if (admissionHeld && store.getRun(result.workerId)?.status === 'queued') {
      // bound: the requested pump awaits repository discovery before reading capacity.
      await vi.waitFor(() => expect(admissionReads.mock.calls.length).toBeGreaterThan(existingWorkers.has(result.workerId) ? 0 : readsBefore), { timeout: 10_000 });
      expect(semaphore.busy()).toBe(0);
    }
    return result;
  });
  const unregister = service.registerProject({ home, id: 'project', root, store, manager });
  return { root, sha, store, manager, parent, credentials, caller, token, service,
    async holdAdmission() { admissionHeld = true; await semaphore.refresh(); },
    async releaseAdmission() { admissionHeld = false; await semaphore.refresh(); await semaphore.release(); },
    async close() {
      unregister();
      credentials.close();
      await removeAfterOwnedWork(root, waitForOwnedWork(manager, store).then(() => drainFixtureManagers(root)).then(() => store.close()));
    } };
}
