import { expect, it } from 'vitest';
import { formatRetentionTable, measureRetention, parseRetentionBenchArgs } from '../../scripts/benchmark-worktree-retention.ts';

/** Smoke test for the retention benchmark: its fixture is what the real store opens, and a
 *  destroyed worker is not a retention candidate, so a pass lists only the live directories. */
it('seeds destroyed worker families and lists only the directories that exist', async () => {
  const row = await measureRetention({ workers: 5, workersPerParent: 2, parentKb: 1, workerKb: 1, liveRoots: 2, passes: 1 });
  expect(row).toMatchObject({ workers: 5, parents: 3, candidates: 2 });
});

it('reads its settings from the command line and refuses ones it cannot use', () => {
  expect(parseRetentionBenchArgs([])).toEqual({ sizes: [100, 1000, 3000], out: undefined,
    base: { workersPerParent: 7, parentKb: 640, workerKb: 50, liveRoots: 20, passes: 3 } });
  expect(parseRetentionBenchArgs(['--workers', '5,10', '--passes', '1', '--out', 'r.json'])).toMatchObject({ sizes: [5, 10], out: 'r.json', base: { passes: 1 } });
  for (const args of [['--workers', '1.5'], ['--workers=-1'], ['--passes', '0'], ['--passes', 'Infinity'], ['--workers-per-parent', '0'], ['--workers-per-parent', '1.5']]) {
    expect(() => parseRetentionBenchArgs(args), args.join(' ')).toThrow('--workers takes whole numbers');
  }
});

it('prints one table row per size', () => {
  const { base } = parseRetentionBenchArgs([]);
  const table = formatRetentionTable(base, [{ workers: 3000, parents: 429, candidates: 20, listMs: 4, passMs: 10 }]).split('\n');
  expect(table[0]).toMatch(/^parent 640 KB, worker 50 KB, 7 workers per parent, 20 live roots, median of 3 passes/);
  expect(table.slice(1)).toEqual(['| destroyed workers | parents | rows listed | list ms | pass ms |', '| ---: | ---: | ---: | ---: | ---: |', '| 3000 | 429 | 20 | 4 | 10 |']);
});
