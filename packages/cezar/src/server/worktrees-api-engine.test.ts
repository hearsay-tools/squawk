import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { spawnCapacityRefusal } from '../delegation/capacity.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-claude.testkit.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { processStartToken } from '../core/process-stat.ts';
import { createOwnedWorkspace } from '../delegation/workspace.ts';
import { createWorktree } from '../git-worktree.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { removeWorktreesRepo, run, seedWorktreeRun, worktreesRepo } from './worktrees-api.testkit.ts';
// Deletion, removal and reclaim ask the shipped autosave gate.
import '../built-in-run-slots.testkit.ts';

sealTestRunners();

/**
 * The worktrees API cases that need a real manager: Continue admission against the reclaim and
 * publish claims, a replacement manager reading persisted autosave cleanup evidence, and a control
 * on a worker whose family the store no longer holds, which the manager adopts first.
 * The route cases are in worktrees-api.test.ts.
 */
describe('the worktrees API on the real engine', { timeout: 30_000 }, () => {
  let repoRoot: string;
  let cezHome: string;
  let store: RunStore;
  let app: Hono;
  let manager: RunManager;
  const savedHome = process.env.CEZ_HOME;

  beforeEach(async () => {
    ({ repoRoot, cezHome } = await worktreesRepo());
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    // A real manager: the reclaim routes claim through it, the same claim Continue is refused by.
    manager = createFixtureManager(store, repoRoot);
    app = createApp({ home: testHome(), repoRoot, store, manager, version: '0.0.0-test' });
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    store.persistence.flush();
    removeWorktreesRepo({ repoRoot, cezHome }, savedHome);
  });

  const seed = (id: string, status: 'done' | 'review' | 'running', finishedAt?: string) => seedWorktreeRun(repoRoot, store, id, status, finishedAt);

  it('human deletion and worktree removal preserve worker and parent ownership evidence', async () => {
    const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    setRunStatus(store, parent.id, RUN_STATUS.done, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
    const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: repoRoot })).stdout.trim();
    const workspace = await createOwnedWorkspace(repoRoot, randomUUID(), sha);
    const worker = store.createOwnedRun({ title: 'worker', task: 'worker', workflow: 'quick-task', steps: [] }, parent.id, randomUUID(),
      { role: 'worker', parentRunId: parent.id, permissions: [], workspace }, 'a'.repeat(64), spawnCapacityRefusal);
    setRunStatus(store, worker.id, RUN_STATUS.cancelled, { worktreePath: workspace.path, branch: workspace.branch });
    store.eventLog.appendEvent(worker.id, { type: 'note', message: 'preserved worker history' });
    for (const id of [worker.id, parent.id]) {
      expect((await apiRequest(app, `/api/v1/runs/${id}`, { method: 'DELETE' })).status).toBe(409);
      expect((await apiRequest(app, `/api/v1/runs/${id}/remove-worktree`, { method: 'POST' })).status).toBe(409);
    }
    expect(existsSync(workspace.path)).toBe(true);
    expect(store.eventLog.readEvents(worker.id)).toEqual(expect.arrayContaining([expect.objectContaining({ message: 'preserved worker history' })]));
    store.updateRun(worker.id, { delegation: { role: 'invalid' } });
    expect((await apiRequest(app, `/api/v1/runs/${worker.id}`, { method: 'DELETE' })).status).toBe(409);
    expect(existsSync(workspace.path)).toBe(true);
  });

  describe('POST /worktrees/:runId/reclaim (issue 08 §B4)', () => {
    const reclaimOne = (id: string) => apiRequest(app, `/api/v1/worktrees/${id}/reclaim`, { method: 'POST' });

    /** A finished run with an agent session, so Continue is admissible (the bundled mock serves it). */
    const resumable = async () => {
      const wt = await createWorktree(repoRoot, randomUUID(), 'main');
      const rec = store.createRun({ title: 'resumable', workflow: 'w', task: 't', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
      store.updateStep(rec.id, 'task', { status: STEP_STATUS.done, sessionId: 'sess-1', backend: 'claude' });
      setRunStatus(store, rec.id, RUN_STATUS.done, { finishedAt: '2026-07-01T00:00:00Z', worktreePath: wt.path, branch: wt.branch });
      return rec.id;
    };
    const savedDryRun = process.env.CEZ_DRY_RUN;
    beforeEach(() => { process.env.CEZ_DRY_RUN = '1'; });
    afterEach(() => {
      if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
      else process.env.CEZ_DRY_RUN = savedDryRun;
    });

    it('holds Continue off for the whole removal, and admits it again once the directory is gone', async () => {
      const id = await resumable();
      // Continue arrives the moment the handler holds its claim, while the removal is still awaiting.
      const claimed = new Promise<void>((resolve) => {
        const claim = manager.claimWorktreeReclaim.bind(manager);
        vi.spyOn(manager, 'claimWorktreeReclaim').mockImplementation((runId) => {
          const release = claim(runId);
          resolve();
          return release;
        });
      });
      const pending = reclaimOne(id);
      await claimed;
      expect(manager.continueRun(id, { text: 'go on' })).toEqual({ ok: false, error: expect.stringContaining('being cleaned up') });
      expect((await pending).status).toBe(200);
      expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(false);
      // Released: the next Continue is admitted, and re-materializes the reclaimed tree.
      expect(manager.continueRun(id, { text: 'go on' }).ok).toBe(true);
    });

    it('holds reclaim off a restored checkout for as long as its draft PR is publishing', async () => {
      const id = await seed(randomUUID(), 'done', '2026-07-01T00:00:00Z');
      // Restored and unstamped, this is exactly what the PR route has just re-materialized.
      const release = manager.claimForPublish(id)!;
      expect((await reclaimOne(id)).status).toBe(409);
      expect(manager.claimForBranchCleanup([id])).toBeNull();
      expect(manager.continueRun(id, { text: 'go on' })).toMatchObject({ ok: false });
      expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(true);
      release();
      expect((await reclaimOne(id)).status).toBe(200);

      // And the route holds that claim from before the restore until it answers.
      const spy = vi.spyOn(manager, 'claimForPublish');
      const other = await seed(randomUUID(), 'done', '2026-07-02T00:00:00Z');
      await apiRequest(app, `/api/v1/runs/${other}/pr`, { method: 'POST' });
      expect(spy).toHaveBeenCalledWith(other);
      expect(manager.claimForPublish(other)).not.toBeNull(); // released afterwards
    });

    it('409s while a run is being Continued, and leaves its directory alone', async () => {
      const id = await resumable();
      expect(manager.continueRun(id, { text: 'go on' }).ok).toBe(true);
      expect((await reclaimOne(id)).status).toBe(409);
      expect(existsSync(store.getRun(id)!.worktreePath!)).toBe(true);
    });
  });

  it('a replacement manager refuses reuse and deletion under persisted autosave cleanup', async () => {
    const id = await seed(randomUUID(), 'done');
    const path = store.getRun(id)!.worktreePath!;
    const evidence = join(repoRoot, '.ai/cezar/runs', `${id}.autosave-cleanup.json`);
    writeFileSync(evidence, JSON.stringify({
      version: 1, cwd: path, controller: { pid: process.pid, startToken: processStartToken(process.pid) },
      processes: [], groups: [], uncertain: false, message: 'cleanup pending',
    }));
    manager.dispose(); store.close();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    manager = createFixtureManager(store, repoRoot);
    app = createApp({ home: testHome(), repoRoot, store, manager, version: '0.0.0-test' });
    expect(manager.continueRun(id, { text: 'continue' }).ok).toBe(false);
    expect(manager.claimForPublish(id)).toBeNull();
    expect(manager.claimWorktreeReclaim(id)).toBeNull();
    expect(manager.claimForBranchCleanup([id])).toBeNull();
    expect(store.retention.canDeleteRun(id)).toBe(false);
    for (const [suffix, method] of [['/remove-worktree', 'POST'], ['', 'DELETE'], ['/git/commit', 'POST'], ['/git/push', 'POST']] as const) {
      expect((await apiRequest(app, `/api/v1/runs/${id}${suffix}`, {
        method, ...(suffix === '/git/commit' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'unsafe' }) } : {}),
      })).status).toBe(409);
    }
    expect(existsSync(path)).toBe(true);
    rmSync(evidence);
    const release = manager.claimForPublish(id); expect(release).not.toBeNull(); release?.();
  });

});
