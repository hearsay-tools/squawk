import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { spawnCapacityRefusal } from './capacity.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { workerExecutionStopped } from '../workflows/run/run-guards.ts';
import { workerCollectedResultSchema } from '@open-mercato/cezar-contract/delegation';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { runPersistence } from '../runs/run-store-open.testkit.ts';
import { scopeFixtureProcesses } from './process-scope.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { onTestFinished, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixture, scheduledDestroyAttempts } from './service.testkit.ts';
import { completedWorker, DISCARD, interruptParentDeletion } from './destruction-results.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { planOwnedWorkspace } from './workspace.ts';
import { RunStore } from '../runs/store.ts';
import { RunDatabase, RUNS_IMPORT_COMPLETE_KEY } from '../runs/run-database.ts';
import { encodeRunRow } from '../runs/run-row.ts';
import { readPersistedRuns, seedRuns, runIds } from '../runs/run-store.testkit.ts';
import { workerCleanups } from './worker-cleanup.ts';

sealTestRunners();

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs') & { default: typeof import('node:fs') }>();
  return { ...fs,
    // Keep enumeration live while this suite injects only removal failures.
    readdirSync: (...args: Parameters<typeof fs.readdirSync>) => fs.default.readdirSync(...args),
    rmSync: vi.fn(fs.rmSync),
  };
});

// Git worktree teardown contends under full-suite workers. Timeout matches the suite's 15s git waits rather than the 5s default.
describe('verified destruction retains results through explicit history deletion', { timeout: 15_000 }, () => {
  let f: ReturnType<typeof fixture>;
  beforeEach(() => { onTestFinished(scopeFixtureProcesses()); f = fixture(workerCleanups()); });
  afterEach(async () => {
    for (const run of f.store.queries.listRuns()) f.manager.cancel(run.id);
    vi.restoreAllMocks(); await f.close(); vi.unstubAllEnvs();
  });
  const completed = () => completedWorker(f);
  const interruptedParentDeletion = () => interruptParentDeletion(f);
  it('destroys legacy resources while keeping a duplicate fallback record untouched', async () => {
    const { workerId, workspace } = await completed();
    const directory = join(f.root, '.ai/squawk');
    mkdirSync(directory, { recursive: true });
    const db = RunDatabase.open(join(directory, 'runs.db'));
    db.transaction({ upserts: [encodeRunRow(f.store.getRun(workerId)!)], deletes: [], meta: { [RUNS_IMPORT_COMPLETE_KEY]: 'fixture' } });
    db.close();
    const bytes = readFileSync(join(directory, 'runs.db'));
    // The source was added after this fixture's store opened. Report its duplicate
    // presence through the ordinary query while keeping the live manager attached.
    vi.spyOn(f.store.claims, 'hasFallbackRun').mockImplementation(id => id === workerId);
    expect(f.store.retention.fallbackDeleteError(workerId)).toContain('.ai/squawk');
    expect(await f.service.destroy(f.caller, { workerId }, DISCARD)).toMatchObject({ state: 'complete' });
    expect(existsSync(workspace.path)).toBe(false);
    expect(f.store.getRun(workerId)).toBeDefined();
    expect(readFileSync(join(directory, 'runs.db'))).toEqual(bytes);
  });

  it('leaves worktree and branch intact when the parent result checkpoint fails', async () => {
    const { workerId, workspace } = await completed();
    vi.spyOn(f.store.workerResults, 'commitWorkerResult').mockImplementation(() => { throw Error('snapshot disk failure'); });
    await expect(f.service.destroy(f.caller, { workerId }, DISCARD)).rejects.toThrow('snapshot disk failure');
    expect(readFileSync(join(workspace.path, 'result.txt'), 'utf8')).toBe('retained patch');
    expect(execFileSync('git', ['rev-parse', `refs/heads/${workspace.branch}`], { cwd: f.root, encoding: 'utf8' }).trim()).toBe(f.sha);
  });
  // Two full destroy attempts (the explicit one that meets the lock, then the awaited retry) on top of
  // the worker setup: about twice the Git work of this suite's other cases, so twice its 15 s budget.
  // With every owned-workspace Git call slowed by 100 ms it needs ~10 s (hearsay-tools/cezarion#1109).
  it('retries a locked owned worktree after the Git lock is removed', { timeout: 30_000 }, async () => {
    await f.close();
    f = fixture(workerCleanups({ backoff: { fastMs: 50, fastCount: 100, capMs: 50 } }));
    const { workerId, workspace } = await completed();
    execFileSync('git', ['worktree', 'lock', workspace.path], { cwd: f.root });
    expect(await f.service.destroy(f.caller, { workerId }, DISCARD)).toMatchObject({ state: 'incomplete', remaining: ['worktree', 'branch'] });
    expect(existsSync(workspace.path)).toBe(true);
    // Armed before the unlock, and no timer can fire between the destroy's return and here, so the
    // first scheduled attempt is the one that sees the lock gone.
    const attempts = scheduledDestroyAttempts(f.service);
    execFileSync('git', ['worktree', 'unlock', workspace.path], { cwd: f.root });
    // The wait covers only what starts that attempt: one 50 ms tick and a stat-only change check, and
    // its bound only ends a hang. The attempt itself (evidence capture, removal, the lock keeper: tens
    // of Git and node spawns) is awaited, not timed: at load ~90 it outlasted 3 s and was caught
    // mid-`cleaning` (hearsay-tools/cezarion#1109).
    await vi.waitFor(() => expect(attempts.length).toBeGreaterThan(0), { timeout: 15_000 });
    await attempts[0];
    // That first retry after the unlock completes the destroy; it is not left to a later one.
    expect(f.store.getRun(workerId)?.delegation).toMatchObject({ destroy: { phase: 'complete', remaining: [] } });
    expect(existsSync(workspace.path)).toBe(false);
  });
  it('preserves a settled summary and diff after destruction, child deletion and restart', async () => {
    const { workerId, workspace, generation, files } = await completed();
    expect(await f.service.destroy(f.caller, { workerId }, DISCARD)).toMatchObject({ state: 'complete', deleted: [
      { kind: 'worktree', path: workspace.path }, { kind: 'branch', ref: `refs/heads/${workspace.branch}` },
    ] });
    expect(f.store.workerExecutions.readWorkerExecution(workerId)).toMatchObject({ phase: 'complete', generation });
    expect(f.store.workerResults.readWorkerResult(f.parent.id, workerId)).toMatchObject({ status: workerCollectedResultSchema.shape.status.enum.review, settled: true, partial: false,
      outcome: 'destroyed', lastExecutionOutcome: 'review-ready', cleanup: 'complete', workspace: { state: 'deleted' },
      summary: { state: 'available', text: 'Completed implementation' }, diff: { state: 'available' }, head: { state: 'deleted', sha: f.sha } });
    expect(existsSync(join(files, `${workerId}-images/worker-context-0.input`))).toBe(true);
    expect(f.store.retention.canDeleteRun(f.parent.id)).toBe(false);
    expect(f.store.retention.deleteRun(workerId)).toBe(true);
    for (const name of [`${workerId}.ndjson`, `${workerId}.handoff.md`, `${workerId}-images`]) expect(existsSync(join(files, name))).toBe(false);
    f.store.close(); // a restart: the old store must not still own the parent's family
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    f.service.registerProject({ home: testHome(), id: 'project', root: f.root, store: reopened, manager: f.manager });
    const result = await f.service.collect(f.caller, { workerId });
    expect(result).toMatchObject({ settled: true, summary: { text: 'Completed implementation' }, workspace: { state: 'deleted' },
      artifacts: { state: 'available', items: [{ state: 'deleted', id: 'worker-context-0.input' }] } });
    expect(reopened.workerResults.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
    expect(reopened.retention.deleteRun(f.parent.id)).toBe(true);
    expect(existsSync(join(files, `${f.parent.id}-worker-results`))).toBe(false);
    reopened.persistence.flush();
  });
  it('keeps updated delegation.results when deleting a worker whose settled parent is cold', async () => {
    const { workerId } = await completed();
    expect(await f.service.destroy(f.caller, { workerId }, DISCARD)).toMatchObject({ state: 'complete' });
    setRunStatus(f.store, f.parent.id, RUN_STATUS.done);
    f.store.close();
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    onTestFinished(() => reopened.close());
    const before = reopened.getRun(f.parent.id);
    if (before?.delegation?.role !== 'root') throw Error('fixture');
    const beforeSnapshotId = before.delegation.results?.find(entry => entry.workerId === workerId)?.snapshotId;
    expect(beforeSnapshotId).toBeDefined();
    expect(reopened.retention.deleteRun(workerId)).toBe(true);
    const after = reopened.getRun(f.parent.id);
    if (after?.delegation?.role !== 'root') throw Error('missing parent');
    const afterSnapshotId = after.delegation.results?.find(entry => entry.workerId === workerId)?.snapshotId;
    expect(afterSnapshotId).toBeDefined();
    expect(afterSnapshotId).not.toBe(beforeSnapshotId);
    const persistedParent = readPersistedRuns(join(f.root, '.ai/cezar')).find((run: { id: string }) => run.id === f.parent.id);
    expect(persistedParent?.delegation?.results?.find((entry: { workerId: string }) => entry.workerId === workerId)?.snapshotId).toBe(afterSnapshotId);
    expect(reopened.workerResults.readWorkerResult(f.parent.id, workerId)).toMatchObject({
      settled: true,
      summary: { text: 'Completed implementation' },
      artifacts: { state: 'available', items: [{ state: 'deleted', id: 'worker-context-0.input' }] },
    });
    expect(reopened.workerResults.readDeletedWorkerResult(f.parent.id, workerId)).toMatchObject({
      settled: true,
      artifacts: { state: 'available', items: [{ state: 'deleted', id: 'worker-context-0.input' }] },
    });
    expect(reopened.workerResults.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
    expect(reopened.retention.canDeleteRun(f.parent.id)).toBe(true);
    expect(reopened.retention.deleteRun(f.parent.id)).toBe(true);
    reopened.persistence.flush();
  });
  it('refuses child deletion without valid parent result bytes and current termination evidence', async () => {
    const { workerId, files } = await completed();
    await f.service.destroy(f.caller, { workerId }, DISCARD);
    const path = join(files, `${workerId}.execution.json`); const proof = readFileSync(path, 'utf8');
    writeFileSync(path, JSON.stringify({ generation: randomUUID(), phase: 'starting' }));
    expect(f.store.retention.deleteRun(workerId)).toBe(false); writeFileSync(path, proof);
    const result = f.store.workerResults.readWorkerResult(f.parent.id, workerId)!;
    expect(result).toBeDefined();
    if (result.diff.state !== 'available') throw Error('missing diff');
    writeFileSync(result.diff.path, '{}');
    expect(f.store.retention.deleteRun(workerId)).toBe(false);
    expect(existsSync(join(files, `${workerId}.ndjson`))).toBe(true);
  });
  it('checkpoints deletion before bytes and retries failed removal after reopening', async () => {
    const { workerId, files } = await completed(); await f.service.destroy(f.caller, { workerId }, DISCARD);
    const real = vi.mocked(rmSync).getMockImplementation()!;
    vi.mocked(rmSync).mockImplementation((path, options) => {
      if (path === join(files, `${workerId}-images`)) {
        const disk = readPersistedRuns(join(f.root, '.ai/cezar'));
        expect(disk.find((r: { id: string }) => r.id === f.parent.id).delegation.receipts[0].deletion.phase).toBe('pending');
        throw Error('directory busy');
      }
      return real(path, options);
    });
    expect(f.store.retention.deleteRun(workerId)).toBe(false);
    expect(f.store.getRun(workerId)).toBeDefined();
    expect(existsSync(join(files, `${workerId}-images/worker-context-0.input`))).toBe(true);
    vi.mocked(rmSync).mockImplementation(real);
    f.store.close(); // a restart: the old store must not still own the parent's family
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.retention.deleteRun(workerId)).toBe(true);
    expect(existsSync(join(files, `${workerId}-images`))).toBe(false);
    expect(reopened.retention.canDeleteRun(f.parent.id)).toBe(true); reopened.persistence.flush();
  });
  it('does not remove child history on a failed deletion metadata checkpoint', async () => {
    const { workerId, files } = await completed(); await f.service.destroy(f.caller, { workerId }, DISCARD);
    const fault = vi.spyOn(runPersistence(f.store), 'persist').mockImplementation(() => { throw Error('index disk failure'); });
    expect(f.store.retention.deleteRun(workerId)).toBe(false);
    expect(existsSync(join(files, `${workerId}.ndjson`))).toBe(true);
    expect(existsSync(join(files, `${workerId}-images/worker-context-0.input`))).toBe(true);
    fault.mockRestore();
  });
  it('retains the pre-removal snapshot when cleanup result publication fails and retries without losing its diff', async () => {
    const { workerId } = await completed();
    const original = f.store.workerResults.commitWorkerResult.bind(f.store.workerResults); let calls = 0;
    const fault = vi.spyOn(f.store.workerResults, 'commitWorkerResult').mockImplementation((...args) => {
      if (++calls === 2) throw Error('final result checkpoint failed');
      return original(...args);
    });
    await expect(f.service.destroy(f.caller, { workerId }, DISCARD)).rejects.toThrow('final result checkpoint failed');
    expect(f.store.retention.canDeleteRun(workerId)).toBe(false);
    expect(f.store.workerResults.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
    fault.mockRestore();
    expect(await f.service.destroy(f.caller, { workerId }, DISCARD)).toMatchObject({ state: 'complete' });
    expect(f.store.workerResults.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
  });
  it('collection and destroy cannot erase evidence during an interrupted child deletion', async () => {
    const { workerId, files } = await completed(); await f.service.destroy(f.caller, { workerId }, DISCARD);
    const original = runPersistence(f.store).persist;
    const fault = vi.spyOn(runPersistence(f.store), 'persist').mockImplementation((changes, transaction) => {
      if (changes.deletes.includes(workerId)) throw Error('final deletion checkpoint failed');
      return original(changes, transaction);
    });
    expect(f.store.retention.deleteRun(workerId)).toBe(false);
    expect(existsSync(join(files, `${workerId}.execution.json`))).toBe(false);
    expect(await f.service.collect(f.caller, { workerId })).toMatchObject({ summary: { state: 'available', text: 'Completed implementation' }, diff: { state: 'available' }, settled: true });
    await expect(f.service.destroy(f.caller, { workerId }, DISCARD)).rejects.toMatchObject({ code: 'incompatible_state' });
    fault.mockRestore();
    expect(f.store.retention.deleteRun(workerId)).toBe(true);
  });
  it('retries interrupted parent deletion after its snapshot directory was removed', async () => {
    const { workerId, files } = await completed(); await f.service.destroy(f.caller, { workerId }, DISCARD); expect(f.store.retention.deleteRun(workerId)).toBe(true);
    const original = runPersistence(f.store).persist;
    const fault = vi.spyOn(runPersistence(f.store), 'persist').mockImplementation((changes, transaction) => {
      if (changes.deletes.includes(f.parent.id)) throw Error('final parent checkpoint failed');
      return original(changes, transaction);
    });
    expect(f.store.retention.deleteRun(f.parent.id)).toBe(false);
    expect(existsSync(join(files, `${f.parent.id}-worker-results`))).toBe(false);
    fault.mockRestore();
    f.store.close(); // a restart: the old store must not still own the parent's family
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.retention.deleteRun(f.parent.id)).toBe(true); reopened.persistence.flush();
  });
  it.each(['missing', 'malformed'] as const)('does not let a %s parent authorize deletion of cleaned child history', async kind => {
    const { workerId, files } = await completed(); await f.service.destroy(f.caller, { workerId }, DISCARD);
    const records = f.store.queries.listRuns();
    const parent = records.find(run => run.id === f.parent.id)!;
    f.store.close(); // a restart: the old store must not still own the parent's family
    seedRuns(join(f.root, '.ai/cezar'), kind === 'missing' ? records.filter(run => run.id !== parent.id)
      : records.map(run => run.id === parent.id ? { ...run, delegation: { invalid: true } } : run));
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.retention.deleteRun(workerId)).toBe(false);
    expect(existsSync(join(files, `${workerId}.ndjson`))).toBe(true); reopened.persistence.flush();
  });
  it('keeps worker history and parent snapshots through ordinary run retention eviction', async () => {
    const { workerId } = await completed(); await f.service.destroy(f.caller, { workerId }, DISCARD);
    f.store.updateRun(workerId, { createdAt: '2000-01-01T00:00:00.000Z' });
    f.store.updateRun(f.parent.id, { createdAt: '2000-01-01T00:00:00.000Z' });
    const ordinary = f.store.createRun({ task: 'old', title: 'old', workflow: 'quick-task', steps: [] });
    setRunStatus(f.store, ordinary.id, RUN_STATUS.done, { createdAt: '2000-01-01T00:00:00.000Z' });
    for (let i = 0; i < 302; i++) f.store.createRun({ task: 'new', title: 'new', workflow: 'quick-task', steps: [] });
    expect(f.store.getRun(ordinary.id)).toMatchObject({ archived: true });
    expect(f.store.getRun(workerId)).toBeDefined();
    expect(f.store.getRun(workerId)?.archived).not.toBe(true);
    expect(f.store.getRun(f.parent.id)).toBeDefined();
    expect(f.store.getRun(f.parent.id)?.archived).not.toBe(true);
    expect(f.store.workerResults.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
  });

  it('reports branch-only cleanup failure while keeping the removed workspace and retained diff explicit on recollection', async () => {
    const { workerId, workspace } = await completed();
    const lock = join(f.root, '.git/refs/heads', `${workspace.branch}.lock`); writeFileSync(lock, 'locked');
    expect(await f.service.destroy(f.caller, { workerId }, DISCARD)).toMatchObject({ state: 'incomplete', remaining: ['branch'],
      error: expect.any(String), deleted: [{ kind: 'worktree', path: workspace.path }] });
    expect(await f.service.collect(f.caller, { workerId })).toMatchObject({ cleanup: 'incomplete', workspace: { state: 'deleted' },
      head: { state: 'deleted', sha: f.sha }, diff: { state: 'available' } });
    expect(f.store.retention.deleteRun(workerId)).toBe(false);
    rmSync(lock); expect(await f.service.destroy(f.caller, { workerId }, DISCARD)).toMatchObject({ state: 'complete' });
    expect(f.store.workerResults.readWorkerResultDiff(f.parent.id, workerId)).toContain('+retained patch');
  });
  it('allows terminal finished parent deletion only after every child history has a complete deletion receipt', async () => {
    const { workerId } = await completed(); await f.service.destroy(f.caller, { workerId }, DISCARD);
    expect(f.store.retention.deleteRun(workerId)).toBe(true);
    const parent = f.store.getRun(f.parent.id)!;
    if (parent.delegation?.role !== 'root') throw Error('fixture');
    f.store.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation, finishRequestedAt: new Date().toISOString() } }]);
    expect(f.store.retention.canDeleteRun(parent.id)).toBe(false);
    setRunStatus(f.store, parent.id, RUN_STATUS.done);
    expect(f.store.retention.deleteRun(parent.id)).toBe(true);
  });
  it('denies parent deletion when a missing child has a result but no completed deletion receipt', async () => {
    const { workerId } = await completed(); await f.service.destroy(f.caller, { workerId }, DISCARD);
    f.store.close(); // a restart: the old store must not still own the parent's family
    seedRuns(join(f.root, '.ai/cezar'), f.store.queries.listRuns().filter(run => run.id !== workerId));
    const reopened = RunStore.open(join(f.root, '.ai/cezar'), { keepLive: true });
    expect(reopened.workerResults.readWorkerResult(f.parent.id, workerId)).toBeDefined();
    expect(reopened.retention.deleteRun(f.parent.id)).toBe(false); reopened.persistence.flush();
  });

  it('refuses spawn under a deleting parent even when its persisted public status is active', async () => {
    interruptedParentDeletion(); setRunStatus(f.store, f.parent.id, RUN_STATUS.running);
    await expect(f.service.spawn(f.caller, { task: 'child', baseline: 'HEAD', requestId: randomUUID() })).rejects.toMatchObject({ code: 'incompatible_state' });
    expect(f.store.queries.listRuns()).toHaveLength(1);
    expect(f.store.retention.deleteRun(f.parent.id)).toBe(true);
  });
  it('refuses construction from a deleting parent without recreating its resources', () => {
    interruptedParentDeletion();
    const before = f.store.eventLog.readEvents(f.parent.id);
    const stopped = vi.fn(() => false);
    expect(workerExecutionStopped(f.store, f.parent.id, stopped)).toBe(true);
    expect(stopped).not.toHaveBeenCalled();
    expect(f.store.eventLog.readEvents(f.parent.id)).toEqual(before);
    expect(existsSync(join(f.root, '.ai/cezar/worktrees', f.parent.id))).toBe(false);
    expect(f.manager.isActive(f.parent.id)).toBe(false);
    expect(f.store.getRun(f.parent.id)?.delegation).toMatchObject({ historyDeletion: 'pending' });
    expect(f.store.retention.deleteRun(f.parent.id)).toBe(true);
  });

  it('refuses the owned-run acceptance boundary after interrupted parent deletion', async () => {
    const workspace = await planOwnedWorkspace(f.root, randomUUID(), f.sha);
    interruptedParentDeletion();
    expect(() => f.store.createOwnedRun({ title: 'child', task: 'child', workflow: 'quick-task', steps: [] }, f.parent.id, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: f.parent.id, workspace }, 'a'.repeat(64), spawnCapacityRefusal)).toThrow('invalid delegation parent');
    expect(runIds(f.store)).toHaveLength(1);
    expect(f.store.retention.deleteRun(f.parent.id)).toBe(true);
  });

});
