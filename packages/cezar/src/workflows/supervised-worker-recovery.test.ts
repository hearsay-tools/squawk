import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workerOperationSchema } from '@open-mercato/cezar-contract/delegation';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { manager, parent, restart, root, store, until, useWorkerWaitFixture, worker } from './worker-wait-claude.testkit.ts';

/**
 * A restart finds a worker that another worker started still live while that supervisor has
 * settled: the crash fell between the supervisor's settlement and the cancel of its worker
 * (hearsay-tools/squawk#3819). Recovery cancels it, whatever way the supervisor settled.
 */
// Real Git, durable checkpoints and the restart share this budget.
describe('restart recovery of a worker whose supervisor has settled', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();

  it.each([RUN_STATUS.failed, RUN_STATUS.cancelled, RUN_STATUS.done])('cancels the live worker of a supervisor that is %s', async settled => {
    const p = await parent();
    await until(() => store.getRun(p.id)?.status === RUN_STATUS.waiting);
    const w = await worker(p.id);
    manager.enqueueOwnedRun(w.id);
    await until(() => store.getRun(w.id)?.status === RUN_STATUS.running && !!store.getRun(w.id)?.worktreePath);
    // The grant a root's worker gets at its creation; the kit's worker record has none.
    store.commitDelegation([{ id: w.id, delegation: { ...store.getRun(w.id)!.delegation!, permissions: [...workerOperationSchema.options], spawnGrant: { kinds: ['shared'], live: 1 } } as never }]);
    const child = await worker(w.id);
    manager.enqueueOwnedRun(child.id);
    await until(() => store.getRun(child.id)?.status === RUN_STATUS.running);
    store.persistence.flush();
    const disk = readPersistedRuns(join(root, '.ai/cezar')).map(record => record.id === w.id ? { ...record, status: settled, finishedAt: new Date().toISOString() } : record);
    await restart(false, disk);
    await until(() => store.getRun(child.id)?.status === RUN_STATUS.cancelled);
    expect(store.getRun(w.id)?.status).toBe(settled);
    expect(store.getRun(p.id)?.status).not.toBe(RUN_STATUS.cancelled);
  });
});
