import type { DelegationState } from '@open-mercato/cezar-contract';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { describe, expect, it, vi } from 'vitest';

import { CountedLifecycle } from '../activity/activity.testkit.ts';
import { publishRunWrite, snapshotRun } from '../runs/lifecycle.ts';
import type { RunRecord } from '../runs/store.ts';
import type { DelegationProject } from './service.ts';
import { WorkerCleanup } from './worker-cleanup.ts';

/** A worker whose launch failed before its first step: failed, with no step started. */
const failedWorker = (): RunRecord => makeRunRecord({
  status: RUN_STATUS.failed,
  steps: [],
  delegation: { role: 'worker', permissions: [], parentRunId: 'parent', workspace: { ownerRunId: '' } } as unknown as DelegationState,
});

/** A project whose store holds `run`, with the worker execution phase `phase`, over a lifecycle. */
function cleanupOf(run: RunRecord, phase: () => string) {
  const lifecycle = new CountedLifecycle();
  const store = { lifecycle, getRun: () => run, workerExecutions: { readWorkerExecution: () => ({ phase: phase() }) }, queries: { listWorkerIds: () => [] } };
  const project = { id: 'project', store } as unknown as DelegationProject;
  // The release runs off the publish; its first step is a serialized operation keyed by the worker,
  // which never settles here: the test counts releases, not destroys.
  const serialized = vi.fn(() => new Promise<never>(() => undefined)) as unknown as ConstructorParameters<typeof WorkerCleanup>[2];
  return { lifecycle, serialized, cleanup: new WorkerCleanup(project, () => true, serialized) };
}

const releases = (serialized: unknown, workerId: string) =>
  (serialized as { mock: { calls: unknown[][] } }).mock.calls.filter(([key]) => key === `worker:project:${workerId}`).length;

describe('WorkerCleanup on the run lifecycle', () => {
  it('releases a fail-start on a run.updated that changes no status: the execution completes after the failure', async () => {
    const run = failedWorker();
    let phase = 'running';
    const { lifecycle, serialized, cleanup } = cleanupOf(run, () => phase);
    // The status write: failed, but the execution is not complete yet.
    publishRunWrite(lifecycle, run, snapshotRun({ ...run, status: RUN_STATUS.running }));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(releases(serialized, run.id)).toBe(0);
    // `commitWorkerExecutionComplete`'s second publish: `before` equals `run`, so no status change.
    phase = 'complete';
    lifecycle.publish('run.updated', { run, before: snapshotRun(run) });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(releases(serialized, run.id)).toBe(1);
    cleanup.detach();
  });

  it('reads the worker as it stands now: an older failed snapshot that arrives last releases nothing', async () => {
    const run = failedWorker();
    const current = { ...run, status: RUN_STATUS.running };
    const { lifecycle, serialized, cleanup } = cleanupOf(current, () => 'complete');
    lifecycle.publish('run.updated', { run, before: snapshotRun(run) });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(releases(serialized, run.id)).toBe(0);
    cleanup.detach();
  });

  it('checks a created run too, as the store emitter did', async () => {
    const run = failedWorker();
    const { lifecycle, serialized, cleanup } = cleanupOf(run, () => 'complete');
    lifecycle.publish('run.created', { run });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(releases(serialized, run.id)).toBe(1);
    cleanup.detach();
  });

  it('unsubscribes on detach and releases nothing after it', async () => {
    const run = failedWorker();
    const { lifecycle, serialized, cleanup } = cleanupOf(run, () => 'complete');
    expect(lifecycle.subscriptions).toBe(1);
    cleanup.detach();
    expect(lifecycle.subscriptions).toBe(0);
    lifecycle.publish('run.updated', { run, before: snapshotRun(run) });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(releases(serialized, run.id)).toBe(0);
  });
});
