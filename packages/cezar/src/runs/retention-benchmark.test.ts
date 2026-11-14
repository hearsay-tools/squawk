import { expect, it } from 'vitest';
import { measureRetention } from '../../scripts/benchmark-worktree-retention.ts';

/** Smoke test for the retention benchmark: its fixture is what the real store opens, and a
 *  destroyed worker is not a retention candidate, so a pass lists only the live directories. */
it('seeds destroyed worker families and lists only the directories that exist', async () => {
  const row = await measureRetention({ workers: 5, workersPerParent: 2, parentKb: 1, workerKb: 1, liveRoots: 2, passes: 1 });
  expect(row).toMatchObject({ workers: 5, parents: 3, candidates: 2 });
});
