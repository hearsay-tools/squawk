import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testHome } from '../home/test-home.testkit.ts';
import { autosaveRemovalCleanup } from '../autosave-removal-slots.ts';
import { cleanupSafety, reclaimWorktree } from '../runs/retention.ts';
import type { DeletionGate, DeletionKind, ReclaimPreparation, RemovalCleanup } from '../runs/removal-slots.ts';
import { sealTestRunSlots } from '../runs/removal-slots.testkit.ts';
import { setRunStatus, seedRuns } from '../runs/run-store.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { claimsManager, removeWorktreesRepo, seedWorktreeRun, worktreesRepo } from './worktrees-api.testkit.ts';

/**
 * One case per row of the removal cases table (spec 2026-11-21-run-lifecycle-and-store-ports,
 * "Case tables › Removal cases"): which slots each path asks, in which order, and today's status
 * and message. The slots here record their calls; the worker collect row is in
 * `delegation/collect-removal-case.test.ts`, and the unsealed row in `runs/removal-slots-unsealed.test.ts`.
 */
const calls: string[] = [];
const refused = new Set<DeletionKind>();
const failing = { preparation: false, cleanup: false };
const gate: DeletionGate = {
  name: 'case gate',
  refuse: (_runId, kind) => { calls.push(`gate ${kind}`); return refused.has(kind) ? 'case gate refuses' : undefined; },
};
const preparation: ReclaimPreparation = {
  name: 'case preparation',
  prepare: async () => { calls.push('preparation'); if (failing.preparation) throw new Error('preparation failed'); },
};
const cleanup: RemovalCleanup = {
  name: 'case cleanup',
  removed: () => { calls.push('cleanup'); if (failing.cleanup) throw new Error('cleanup failed'); },
};
sealTestRunSlots({ gates: [gate], preparations: [preparation], cleanups: [cleanup, autosaveRemovalCleanup] });

beforeEach(() => {
  calls.length = 0;
  refused.clear();
  failing.preparation = failing.cleanup = false;
});

describe('removal cases on a real repository', () => {
  let repoRoot: string;
  let cezHome: string;
  let store: RunStore;
  let app: Hono;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(async () => {
    ({ repoRoot, cezHome } = await worktreesRepo());
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ home: testHome(), repoRoot, store, manager: claimsManager(store), version: '0.0.0-test' });
  });

  afterEach(() => {
    store.close();
    removeWorktreesRepo({ repoRoot, cezHome }, savedHome);
  });

  const plainRun = () => {
    const run = store.createRun({ title: 'plain', task: 'plain', workflow: 'quick-task', steps: [] });
    setRunStatus(store, run.id, RUN_STATUS.done);
    return run.id;
  };
  const request = (path: string, method: 'DELETE' | 'POST') => apiRequest(app, `/api/v1${path}`, { method });

  it('DELETE /runs/:id answers a history gate refusal with 409 and today\'s message, and removes nothing', async () => {
    const id = plainRun();
    refused.add('history');
    const response = await request(`/runs/${id}`, 'DELETE');
    expect([response.status, await response.json()]).toEqual([409, { error: 'owned resources require verified worker cleanup and explicit child history deletion first' }]);
    expect(store.getRun(id)).toBeDefined();
    expect(calls).toEqual(['gate history']);
  });

  it('DELETE /runs/:id answers a failed delegated cleanup with 409 "history cleanup incomplete — retry deletion", and a retry deletes', async () => {
    const id = plainRun();
    setRunStatus(store, id, RUN_STATUS.done, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    failing.cleanup = true;
    const failed = await request(`/runs/${id}`, 'DELETE');
    expect([failed.status, await failed.json()]).toEqual([409, { error: 'history cleanup incomplete — retry deletion' }]);
    expect(store.getRun(id)?.delegation).toMatchObject({ role: 'root', historyDeletion: 'pending' });
    expect(calls.slice(-2)).toEqual(['gate history', 'cleanup']);

    failing.cleanup = false;
    const retried = await request(`/runs/${id}`, 'DELETE');
    expect([retried.status, await retried.json()]).toEqual([200, { deleted: true }]);
    expect(store.getRun(id)).toBeUndefined();
  });

  it('DELETE /runs/:id refuses a run whose delegation record is invalid before it asks a gate, as today', async () => {
    const id = plainRun();
    setRunStatus(store, id, RUN_STATUS.done, { delegation: { role: 'invalid' } });
    const response = await request(`/runs/${id}`, 'DELETE');
    expect([response.status, await response.json()]).toEqual([409, { error: 'owned resources require verified worker cleanup and explicit child history deletion first' }]);
    expect(calls).toEqual(['gate history']);
  });

  it('POST /runs/:id/remove-worktree answers a worktree gate refusal with 409 and today\'s message, and keeps the worktree', async () => {
    const id = await seedWorktreeRun(repoRoot, store, randomUUID(), 'done');
    refused.add('worktree');
    const response = await request(`/runs/${id}/remove-worktree`, 'POST');
    expect([response.status, await response.json()]).toEqual([409, { error: 'owned resources require verified worker cleanup' }]);
    expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(true);
    expect(calls).toEqual(['gate worktree']);
  });

  it('worktree reclaim asks the worktree gate, the preparation, then the worktree gate again before the removal', async () => {
    const id = await seedWorktreeRun(repoRoot, store, randomUUID(), 'done', '2026-01-01T00:00:00.000Z');
    const run = store.getRun(id)!;
    expect(await reclaimWorktree(repoRoot, store, run)).toEqual(expect.any(String));
    expect(existsSync(run.worktreePath!)).toBe(false);
    // The last check is the removal's own (`assertCurrent`), after the preview release.
    expect(calls).toEqual(['gate worktree', 'preparation', 'gate worktree']);
  });

  it('worktree reclaim returns null on a gate refusal or a failed preparation, keeps the worktree, and the next pass retries', async () => {
    const id = await seedWorktreeRun(repoRoot, store, randomUUID(), 'done', '2026-01-01T00:00:00.000Z');
    const run = store.getRun(id)!;
    refused.add('worktree');
    expect(await reclaimWorktree(repoRoot, store, run)).toBeNull();
    expect(calls.splice(0)).toEqual(['gate worktree']);
    refused.clear();
    failing.preparation = true;
    expect(await reclaimWorktree(repoRoot, store, run)).toBeNull();
    expect(calls.splice(0)).toEqual(['gate worktree', 'preparation']);
    expect([existsSync(run.worktreePath!), store.getRun(id)?.worktreeReclaimedAt]).toEqual([true, undefined]);
    failing.preparation = false;
    expect(await reclaimWorktree(repoRoot, store, run)).toEqual(expect.any(String));
    expect(existsSync(run.worktreePath!)).toBe(false);
  });

  it('POST /worktrees/:runId/reclaim answers a worktree gate refusal with 409 and today\'s message', async () => {
    const id = await seedWorktreeRun(repoRoot, store, randomUUID(), 'done', '2026-01-01T00:00:00.000Z');
    refused.add('worktree');
    const response = await request(`/worktrees/${id}/reclaim`, 'POST');
    expect([response.status, await response.json()]).toEqual([409, { error: 'the worktree directory could not be removed' }]);
    expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(true);
  });

  it('worker family end: cleanupSafety asks the worktree gate in the run\'s data dir and throws its reason', () => {
    const id = plainRun();
    const assertSafe = cleanupSafety(repoRoot, store, store.getRun(id)!);
    expect(() => assertSafe()).not.toThrow();
    refused.add('worktree');
    expect(() => assertSafe()).toThrow('case gate refuses');
    expect(calls).toEqual(['gate worktree', 'gate worktree']);
  });
});

describe('removal cases in a run store', () => {
  let dataDir: string;
  // Each store a case opens is closed before its fixture directory goes, a failed case's too.
  const stores = new Set<RunStore>();
  const open = (...args: Parameters<typeof RunStore.open>) => { const store = RunStore.open(...args); stores.add(store); return store; };
  const close = (store: RunStore) => { stores.delete(store); store.close(); };
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'cez-removal-cases-')); });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of [...stores]) close(store);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('archive of a settled family keeps a member\'s tmp directory while the archive-tmp gate refuses', () => {
    const run = { title: 'old', workflow: 'quick-task', task: 'old', status: RUN_STATUS.done, createdAt: '2026-01-01T00:00:00.000Z', tokensUsed: 0, archived: false, steps: [] };
    const ids = ['kept-tmp', 'reaped-tmp'];
    seedRuns(dataDir, [...ids.map(id => ({ ...run, id })),
      ...Array.from({ length: 299 }, (_, index) => ({ ...run, id: `newer-${index}`, createdAt: '2026-02-01T00:00:00.000Z' }))]);
    for (const id of ids) mkdirSync(join(dataDir, 'tmp', id), { recursive: true });
    const store = open(dataDir, { keepLive: true });
    const refuseKept: DeletionGate = { name: 'kept', refuse: (runId, kind) => kind === 'archive-tmp' && runId === 'kept-tmp' ? 'a job runs' : undefined };
    gate.refuse = (runId, kind) => { calls.push(`gate ${kind} ${runId}`); return refuseKept.refuse(runId, kind, dataDir); };
    try {
      store.createRun({ title: 'trigger retention', workflow: 'w', task: 'task', steps: [] });
    } finally {
      gate.refuse = (_runId, kind) => { calls.push(`gate ${kind}`); return refused.has(kind) ? 'case gate refuses' : undefined; };
    }
    expect(ids.map(id => [store.getRun(id)?.archived, existsSync(join(dataDir, 'tmp', id))])).toEqual([[true, true], [true, false]]);
    expect(calls).toEqual(['gate archive-tmp kept-tmp', 'gate archive-tmp reaped-tmp']);
  });

  it('plain run history delete asks the history gate, then runs the cleanups after the commit; a failure is logged and the row stays gone', () => {
    const store = open(dataDir);
    const run = store.createRun({ title: 'plain', task: 'plain', workflow: 'quick-task', steps: [] });
    setRunStatus(store, run.id, RUN_STATUS.done);
    store.flush();
    // Autosave evidence is cleared with the other cleanups, after the commit (a changed moment:
    // before C1 the delete cleared it before the commit).
    const evidence = join(dataDir, 'runs', `${run.id}.autosave-cleanup.json`);
    writeFileSync(evidence, '{}');
    failing.cleanup = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(store.retention.deleteRun(run.id)).toBe(true);
    expect(calls).toEqual(['gate history']);
    expect(existsSync(evidence)).toBe(true);
    store.flush();
    expect(calls).toEqual(['gate history', 'cleanup']);
    expect(existsSync(evidence)).toBe(false);
    expect(warn).toHaveBeenCalledWith(`[hsq] History cleanup of run ${run.id} is incomplete: cleanup failed`);
    close(store);
    expect(open(dataDir).getRun(run.id)).toBeUndefined();
  });
});
