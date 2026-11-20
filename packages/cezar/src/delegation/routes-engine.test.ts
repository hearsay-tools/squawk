import { testHome } from '../home/test-home.testkit.ts';
import { createFixtureManager } from '../workflows/fixture-claude.testkit.ts';
import { join } from 'node:path';
import { RunStore } from '../runs/store.ts';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDelegationRoutes } from './routes.ts';
import { fixture } from './service-engine.testkit.ts';
import { seedWorkerWait } from './service.testkit.ts';
import { workerSpawnResultSchema } from '@open-mercato/cezar-contract/delegation';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { workerCleanups } from './worker-cleanup.ts';

// Cancelling an open wait and reading a cancellation after a restart need the run engine.
describe('authenticated delegation HTTP family', () => {
  let f: ReturnType<typeof fixture>, app: ReturnType<typeof createDelegationRoutes>;
  beforeEach(() => { f = fixture(workerCleanups()); app = createDelegationRoutes(f.service, f.credentials); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}, method = body === undefined ? 'GET' : 'POST') => app.request(`http://127.0.0.1${path}`, { method, headers: { host: '127.0.0.1', authorization: `Bearer ${f.token}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function spawn() {
    const response = await request('/spawn', { task: 'work', baseline: 'parent-head', requestId: randomUUID() });
    expect(response.status).toBe(201); return workerSpawnResultSchema.parse(await response.json());
  }
  it('cancels with existing wait-only authority and returns retained settlement on retry', async () => {
    const { workerId } = await spawn();
    // A worker wait in the list (hearsay-tools/cezarion#1235, #1301), registered as `cez worker wait` does.
    const waitId = seedWorkerWait(f.store, f.parent.id, [workerId]);
    const delegation = f.store.getRun(f.parent.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: f.parent.id, delegation: { ...delegation, permissions: ['wait'] } }]);
    const response = await request('/cancel-wait', { waitId });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ wait: { id: waitId, reason: 'cancelled' } });
    expect(await (await request('/cancel-wait', { waitId })).json()).toMatchObject({ wait: { id: waitId, reason: 'cancelled' } });
    expect(f.store.getRun(workerId)?.status).toBe('queued');
    const retired = f.store.getRun(f.parent.id)!.delegation!;
    if (retired.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: f.parent.id, delegation: { ...retired, permissions: ['inspect'] } }]);
    expect((await request('/cancel-wait', { waitId })).status).toBe(403);
  });
  it.each([['queued', false], ['done', false], ['review', false], ['failed', false], ['cancelled', false], ['done', true]] as const)('reads a settled current cancellation over HTTP for a %s parent after restart (legacy=%s)', async (status, legacy) => {
    const { workerId } = await spawn(); const waitId = randomUUID();
    const wait = { id: waitId, workerIds: [workerId], phase: 'wake-pending', reason: 'timeout', wakeId: waitId,
      deadline: new Date(Date.now() - 1000).toISOString(), outcomes: [] };
    const records = f.store.listRuns().map(run => run.id === f.parent.id ? { ...run, status,
      delegation: { ...run.delegation, permissions: ['wait'], wait: legacy ? { id: wait.id, workerIds: wait.workerIds, phase: wait.phase, deadline: wait.deadline, outcomes: wait.outcomes } : wait } } : run);
    // A restart: the old manager and store go, or the store would still own the family it reloads.
    f.manager.dispose(); f.store.close();
    seedRuns(join(f.root, '.ai/cezar'), records);
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true }); const manager = createFixtureManager(reopened, f.root);
    f.service.registerProject({ home: testHome(), id: 'project', root: f.root, store: reopened, manager });
    try {
      for (let i = 0; i < 2; i++) {
        const response = await request('/cancel-wait', { waitId });
        expect(response.status).toBe(200); expect(await response.json()).toEqual({ wait });
      }
      expect(reopened.getRun(workerId)?.status).toBe('queued');
      expect(reopened.getRun(f.parent.id)?.status).toBe(status);
    } finally { manager.dispose(); reopened.flush(); }
  });
});
