import { describe, expect, it } from 'vitest';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunRecord } from '../../runs/store.ts';
import { MaintenanceClaims } from './maintenance-claims.ts';
import { terminalScratchDisposition } from './run-settlement.ts';
import type { RunModuleContext } from './types.ts';

const HOST = '10000000-0000-4000-8000-000000000001', SHARED = '10000000-0000-4000-8000-000000000002', ISOLATED = '10000000-0000-4000-8000-000000000003';
const baselineSha = 'a'.repeat(40);
const workerOf = (id: string, workspace: object): RunRecord => makeRunRecord({ id, status: RUN_STATUS.done,
  delegation: { role: 'worker', permissions: [], parentRunId: HOST, workspace } as RunRecord['delegation'] });
const runs = new Map<string, RunRecord>([
  [HOST, makeRunRecord({ id: HOST, status: RUN_STATUS.failed, delegation: { role: 'root', permissions: [], receipts: [] } })],
  [SHARED, workerOf(SHARED, { ownerRunId: SHARED, resourceId: SHARED, kind: 'shared', path: '/repo/.ai/squawk/worktrees/host', hostRunId: HOST, baselineSha })],
  [ISOLATED, workerOf(ISOLATED, { ownerRunId: ISOLATED, resourceId: ISOLATED, kind: 'owned-isolated', path: '/repo/.ai/squawk/worktrees/isolated', branch: 'cez/10000000', baselineSha })],
]);

function claims(): MaintenanceClaims {
  const store = { getRun: (id: string) => runs.get(id), pin: () => true, unpin: () => undefined, writeRefusal: () => undefined, listWorkersOf: () => [] };
  const instance: MaintenanceClaims = new MaintenanceClaims({ store, disposed: () => false } as unknown as RunModuleContext, {
    isActive: () => false, autosaveCleanupBlocker: () => undefined, hasExecution: () => false, scheduleScratchCleanup: () => undefined,
    holdForMaintenance: ids => instance.holdForMaintenance(ids),
  });
  return instance;
}

describe('a claim on a run whose directory a shared worker works in (hearsay-tools/squawk#3819)', () => {
  it('holds the shared worker off a start, and no other worker', () => {
    const held = claims();
    expect(held.blocksStart(SHARED)).toBe(false);
    const release = held.claimForPublish(HOST);
    expect(release).toEqual(expect.any(Function));
    expect(held.blocksStart(HOST)).toBe(true);
    expect(held.blocksStart(SHARED)).toBe(true);
    expect(held.blocksStart(ISOLATED)).toBe(false);
    expect(held.blocksStart('10000000-0000-4000-8000-00000000ffff')).toBe(false);
    release?.();
    expect(held.blocksStart(SHARED)).toBe(false);
  });

  it("is no claim on the shared worker's own resources: its scratch cleanup is scheduled when it settles meanwhile", () => {
    const held = claims();
    held.claimForPublish(HOST);
    expect(held.has(HOST)).toBe(true);
    expect(held.has(SHARED)).toBe(false);
    const disposition = (id: string) => terminalScratchDisposition(id, runs.get(id), {
      active: () => false, starting: () => false, queued: () => false, claimed: () => held.has(id),
      autosaveBlocker: () => undefined, privateWorkers: () => [], jobHolds: () => false,
    });
    expect(disposition(SHARED)).toBe('schedule');
    expect(disposition(HOST)).toBe('keep');
    expect(held.claimWorkerCleanup(SHARED)).toEqual(expect.any(Function));
  });
});
