import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { createFixtureManager } from '../workflows/fixture-claude.testkit.ts';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { onTestFinished, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './service-engine.testkit.ts';
import { completedWorker, DISCARD, interruptParentDeletion } from './destruction-results.testkit.ts';
import {
  RUN_STATUS,
  WORKER_OUTCOME_STATUS,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import {
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_SOURCE,
  WAIT_VIA,
} from '@open-mercato/cezar-contract/wait-factories.testkit';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { workerCleanups } from './worker-cleanup.ts';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs') & { default: typeof import('node:fs') }>();
  return { ...fs,
    // Keep enumeration live while this suite injects only removal failures.
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => fs.default.readdirSync(...args),
    rmSync: vi.fn(fs.rmSync),
  };
});

// Git worktree teardown + a live RunManager contend under full-suite workers; cancel/dispose
// without polling. Timeout matches the suite's 15s git/manager waits rather than the 5s default.
describe('verified destruction retains results through explicit history deletion', { timeout: 15_000 }, () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { onTestFinished(scopeFixtureProcesses()); f = fixture(workerCleanups()); });
  afterEach(async () => {
    for (const run of f.store.queries.listRuns()) f.manager.cancel(run.id);
    vi.restoreAllMocks(); await f.close(); vi.unstubAllEnvs();
  });
  const completed = () => completedWorker(f);
  const interruptedParentDeletion = () => interruptParentDeletion(f);

  it('keeps an all-wait outcome and its revision after safe child deletion until the other worker settles', async () => {
    const { workerId } = await completed();
    f.store.commitWorkerContinuation(workerId, 'succeed-review');
    const generation = f.store.workerExecutions.commitWorkerExecutionStart(workerId); f.store.workerExecutions.commitWorkerExecutionComplete(workerId, generation);
    const other = await f.service.spawn(f.caller, { task: 'other', baseline: 'HEAD', requestId: randomUUID() });
    const parent = f.store.getRun(f.parent.id)!;
    // A worker wait in the list (hearsay-tools/cezarion#1235, #1301).
    const waitId = randomUUID();
    f.store.commitWait(parent.id, { kind: WAIT_KIND.worker, id: waitId, source: WAIT_SOURCE.agent, via: WAIT_VIA['cez-worker-wait'], registeredAt: new Date().toISOString(),
      deadline: new Date(Date.now() + 600_000).toISOString(), timeoutSeconds: 600, phase: WAIT_PHASE.open, turnId: 'turn-1', mode: 'all',
      workerIds: [workerId, other.workerId], revisions: [{ workerId, revision: 1 }, { workerId: other.workerId, revision: 0 }], outcomes: [] });
    // Parked on the wait with no session, as the product holds it: a running run always has one.
    setRunStatus(f.store, parent.id, RUN_STATUS.waiting);
    const entry = () => f.store.getRun(parent.id)?.waits?.find(wait => wait.id === waitId);
    await f.service.destroy(f.caller, { workerId }, DISCARD); expect(f.store.retention.deleteRun(workerId)).toBe(true);
    f.manager.reconcileWorkerWaits();
    expect(entry()).toMatchObject({ phase: WAIT_PHASE.open, outcomes: [{ workerId, revision: 1, status: WORKER_OUTCOME_STATUS.review }] });
    const retained = f.store.workerResults.readWorkerResult(f.parent.id, workerId)!;
    if (retained.diff.state !== 'available') throw Error('fixture diff');
    const bytes = readFileSync(retained.diff.path, 'utf8');
    writeFileSync(retained.diff.path, '{}');
    f.manager.reconcileWorkerWaits();
    expect(entry()).toMatchObject({ phase: WAIT_PHASE.open, outcomes: [] });
    writeFileSync(retained.diff.path, bytes);
    f.manager.requestWorkerStop(other.workerId);
    f.manager.reconcileWorkerWaits();
    expect(entry()).toMatchObject({ phase: WAIT_PHASE.resolved, result: { reason: 'outcome' },
      outcomes: expect.arrayContaining([{ workerId, revision: 1, status: WORKER_OUTCOME_STATUS.review, observedAt: expect.any(String) },
        { workerId: other.workerId, revision: 0, status: WORKER_OUTCOME_STATUS.cancelled, observedAt: expect.any(String) }]) });
  });

  it('denies replacement evidence whose retained workspace names a different owner', async () => {
    const { workerId } = await completed(); await f.service.destroy(f.caller, { workerId }, DISCARD); expect(f.store.retention.deleteRun(workerId)).toBe(true);
    const result = f.store.workerResults.readWorkerResult(f.parent.id, workerId)!;
    if (result.diff.state !== 'available') throw Error('fixture diff');
    const file = JSON.parse(readFileSync(result.diff.path, 'utf8'));
    file.result.workspace.ownerRunId = randomUUID();
    writeFileSync(result.diff.path, JSON.stringify(file));
    expect(f.store.retention.canDeleteRun(f.parent.id)).toBe(false);
    expect(f.manager.finishBlockedReason(f.parent.id)).toContain(workerId);
    await expect(f.service.collect(f.caller, { workerId })).rejects.toMatchObject({ code: 'denied_scope' });
  });

  it('refuses Continue after interrupted parent deletion without resetting its retry marker', () => {
    interruptedParentDeletion();
    expect(f.manager.continueRun(f.parent.id, { text: 'mock:cezar-done' }, true)).toMatchObject({ ok: false, error: expect.stringContaining('deletion') });
    expect(f.manager.isActive(f.parent.id)).toBe(false);
    expect(f.store.retention.deleteRun(f.parent.id)).toBe(true);
  });
  it.each(['queued', 'running'] as const)('does not revive a %s parent with interrupted deletion on restart', async status => {
    interruptedParentDeletion(); setRunStatus(f.store, f.parent.id, status); f.store.close();
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    // The fixture's drain flushes this store after the test, so it closes once the drain is done.
    onTestFinished(() => reopened.close());
    const semaphore = new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 1 } });
    const manager = createFixtureManager(reopened, f.root, { home: testHome(), semaphore });
    try {
      await manager.recover();
      await semaphore.release();
      expect(manager.isActive(f.parent.id)).toBe(false);
      expect(reopened.getRun(f.parent.id)?.delegation).toMatchObject({ historyDeletion: 'pending' });
      expect(reopened.retention.deleteRun(f.parent.id)).toBe(true);
    } finally { manager.dispose(); reopened.persistence.flush(); }
  });
});
