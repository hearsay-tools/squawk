import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_IN_USE_ELSEWHERE, RunStore } from '../runs/store.ts';
import { MaintenanceClaims } from './run/maintenance-claims.ts';
import type { RunModuleContext } from './run/types.ts';
import { unused } from './unused.testkit.ts';

/**
 * An ownership check is a moment; the work it admits is not (#779, plan step 3, PR #851 review).
 * A Continue admission and the async maintenance claims (publish, worktree reclaim, branch
 * cleanup) must HOLD the run's family claim for as long as they act on it, so another Squawk
 * process cannot claim and Continue the run in between, and must refuse when the hold fails.
 */
describe('claims that admit work on a finished run', () => {
  let root: string;
  let dataDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-maintenance-claims-'));
    dataDir = join(root, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  function settledRun(store: RunStore): string {
    const run = store.createRun({ title: 'settled', workflow: 'quick-task', task: 'settled', steps: [] });
    // A materialized worktree, so worktree reclaim has something to claim.
    const worktreePath = join(root, `wt-${run.id.slice(0, 8)}`); mkdirSync(worktreePath);
    setRunStatus(store, run.id, RUN_STATUS.done, { finishedAt: new Date().toISOString(), branch: `cez/${run.id.slice(0, 8)}`, worktreePath });
    store.flush();
    return run.id;
  }

  /** The claims as `RunManager` composes them, with nothing active, running or autosaving. */
  function claimsFor(store: RunStore): MaintenanceClaims {
    const context = unused<RunModuleContext>('RunModuleContext', { store, disposed: () => false });
    const claims: MaintenanceClaims = new MaintenanceClaims(context, {
      isActive: () => false, autosaveCleanupBlocker: () => undefined, hasExecution: () => false,
      scheduleScratchCleanup: () => undefined, holdForMaintenance: ids => claims.holdForMaintenance(ids),
    });
    return claims;
  }

  const claims: Array<[string, (claimer: MaintenanceClaims, id: string) => (() => void) | null]> = [
    ['publish', (claimer, id) => claimer.claimForPublish(id)],
    ['worktree reclaim', (claimer, id) => claimer.claimWorktreeReclaim(id)],
    ['branch cleanup', (claimer, id) => claimer.claimForBranchCleanup([id])],
  ];

  it.each(claims)('%s holds the family claim until it is released', (_name, claim) => {
    const seed = RunStore.open(dataDir, { keepLive: true });
    const id = settledRun(seed);
    seed.close();

    const ours = RunStore.open(dataDir, { keepLive: true });
    const theirs = RunStore.open(dataDir, { keepLive: true });
    try {
      const release = claim(claimsFor(ours), id);
      expect(release).not.toBeNull();
      // While the claim stands, the other process sees the run as ours and cannot act on it.
      expect(theirs.runOwnership(id)).toBe('foreign');
      expect(theirs.writeRefusal(id)).toBe(RUN_IN_USE_ELSEWHERE);
      release!();
      // A released run leaves memory, and its family claim, at the next save.
      ours.flush();
      expect(theirs.writeRefusal(id)).toBeUndefined();
    } finally {
      ours.close();
      theirs.close();
    }
  });

  it.each(claims)('%s refuses when another process claimed the run first', (_name, claim) => {
    const seed = RunStore.open(dataDir, { keepLive: true });
    const id = settledRun(seed);
    seed.close();

    const ours = RunStore.open(dataDir, { keepLive: true });
    const theirs = RunStore.open(dataDir, { keepLive: true });
    try {
      const claimer = claimsFor(ours);
      // The other process takes the claim after our ownership check would have passed.
      vi.spyOn(ours, 'writeRefusal').mockReturnValue(undefined);
      expect(theirs.pin(id, 'cleanup')).toBeDefined();
      expect(claim(claimer, id)).toBeNull();
    } finally {
      ours.close();
      theirs.close();
    }
  });
});
