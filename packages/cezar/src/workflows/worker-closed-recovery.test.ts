import { spawnCapacityRefusal } from '../delegation/capacity.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { recoveryOver } from './run-recovery-fakes.testkit.ts';

/**
 * A restart finds an owned worker `waiting` with no ask and no wait: its session closed, and a
 * worker cannot take an ordinary inactive Continue, so recovery settles it
 * (`RunRecovery.recoverClosedWaitingRun`). Slice S7, Table B row B11
 * (.ai/specs/2026-11-03-run-store-owns-exits.md): a worker that fails on an ask it cannot show
 * keeps its waiting step, the step a parent resume re-enters (hearsay-tools/cezarion#1620).
 */
describe('restart recovery of a closed waiting worker', () => {
  let dataDir: string;
  let store: RunStore;
  beforeEach(() => {
    dataDir = join(mkdtempSync(join(tmpdir(), 'cez-closed-worker-')), '.ai/cezar');
    store = RunStore.open(dataDir);
  });
  afterEach(() => {
    store.close();
    rmSync(join(dataDir, '../..'), { recursive: true, force: true });
  });

  /** A waiting root with one owned worker its closed session left `waiting`, saved as a crash leaves it. */
  function closedWorker(invalidAsk: boolean): string {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
    setRunStatus(store, parent.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const workerId = randomUUID();
    const w = store.createOwnedRun({ title: 'worker', task: 'mock:hold', workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', kind: STEP_KIND.agent, name: 'Task' }] },
      parent.id, randomUUID(), { role: 'worker', permissions: [], parentRunId: parent.id, workspace: {
        ownerRunId: workerId, resourceId: randomUUID(), kind: 'owned-isolated',
        path: `/managed/${workerId}`, branch: `cez/${workerId.slice(0, 8)}`, baselineSha: 'a'.repeat(40),
      } }, 'a'.repeat(64), spawnCapacityRefusal);
    {
      const { status: fixtureStatus, ...fixtureExtras }: NonNullable<Parameters<typeof setRunStatus>[3]> & { status: Parameters<typeof setRunStatus>[2] } = { status: RUN_STATUS.waiting, currentStepId: 'task', ...(invalidAsk ? { invalidAsk: true } : {}) };
      setRunStatus(store, w.id, fixtureStatus, fixtureExtras);
    }
    store.updateStep(w.id, 'task', { status: STEP_STATUS.waiting, iterations: 1 });
    store.persistence.flush();
    return w.id;
  }

  /** The restart: a new store reads the saved rows, and recovery runs over it. Returns the plain
   *  pair, because a promise that resolves to the host proxy would read its `then`. */
  async function restart() {
    store.close();
    store = RunStore.open(dataDir, { keepLive: true });
    const recovered = recoveryOver(store);
    await recovered.recovery.recover();
    return recovered;
  }

  it('fails a worker whose ask cannot be shown, and keeps its waiting step', async () => {
    const id = closedWorker(true);
    await restart();
    const run = store.getRun(id)!;
    expect(run).toMatchObject({ status: RUN_STATUS.failed, error: 'invalid structured question', finishedAt: expect.any(String) });
    expect(run.currentStepId).toBeUndefined();
    expect(run.steps.map(step => step.status)).toEqual([STEP_STATUS.waiting]);
  });

  it('settles any other closed worker done, its step with it', async () => {
    const id = closedWorker(false);
    const { host } = await restart();
    // Settlement itself is RunSettlement's: recovery hands the worker to it once.
    expect(host.settleSuccess).toHaveBeenCalledExactlyOnceWith(id);
    expect(store.getRun(id)?.steps.map(step => step.status)).toEqual([STEP_STATUS.done]);
    expect(store.eventLog.readEvents(id).some(event => event.type === 'lifecycle' && event.message === 'cezar restarted — the open worker session was settled')).toBe(true);
  });
});
