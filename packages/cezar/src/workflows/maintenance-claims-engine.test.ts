import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_IN_USE_ELSEWHERE, RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-no-runner.testkit.ts';
import type { RunManager } from './run.ts';

/**
 * An ownership check is a moment; the work it admits is not (hearsay-tools/cezarion#779, plan step 3, hearsay-tools/cezarion#851 review).
 * A Continue admission and the async maintenance claims (publish, worktree reclaim, branch
 * cleanup) must HOLD the run's family claim for as long as they act on it, so another Squawk
 * process cannot claim and Continue the run in between, and must refuse when the hold fails.
 */
describe('claims that admit work on a finished run', () => {
  let root: string;
  let dataDir: string;
  const savedDryRun = process.env.CEZ_DRY_RUN;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    root = mkdtempSync(join(tmpdir(), 'cez-maintenance-claims-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    dataDir = join(root, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await drainFixtureManagers(root);
    rmSync(root, { recursive: true, force: true });
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  function settledRun(store: RunStore): string {
    const run = store.createRun({ title: 'settled', workflow: 'quick-task', task: 'settled', steps: [] });
    // A materialized worktree, so worktree reclaim has something to claim.
    const worktreePath = join(root, `wt-${run.id.slice(0, 8)}`); mkdirSync(worktreePath);
    setRunStatus(store, run.id, RUN_STATUS.done, { finishedAt: new Date().toISOString(), branch: `cez/${run.id.slice(0, 8)}`, worktreePath });
    store.flush();
    return run.id;
  }

  function managerFor(store: RunStore): RunManager {
    return createFixtureManager(store, root, { home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 0 } }) });
  }

  it('Continue refuses, and starts nothing, when the run cannot be held', () => {
    const store = RunStore.open(dataDir, { keepLive: true });
    try {
      const id = settledRun(store);
      const manager = managerFor(store);
      // Another process claimed the run between the ownership check and the hold.
      vi.spyOn(store, 'pin').mockReturnValue(undefined);
      const result = manager.continueRun(id);
      expect(result).toEqual({ ok: false, error: RUN_IN_USE_ELSEWHERE });
      expect(store.getRun(id)?.status).toBe('done');
      expect(manager.isActive(id)).toBe(false);
    } finally {
      store.close();
    }
  });
});
