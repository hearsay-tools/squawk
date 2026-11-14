/**
 * Worktree retention benchmark: what one retention pass costs the main thread as a project's
 * history of destroyed workers grows. Every settled run starts a pass, and a pass runs on the
 * event loop, so its time is what every cockpit request waits behind. Run it unchanged before and
 * after a change to retention or to the rows it reads.
 *
 *   npm run bench:worktree-retention -w @wjarka/cezarion
 *   node --import tsx packages/cezar/scripts/benchmark-worktree-retention.ts --workers 100,1000,3000
 *
 * Flags: --workers (100,1000,3000) --workers-per-parent (7) --parent-kb (640) --worker-kb (50)
 * --live-roots (20) --passes (3) --out (a JSON file for the result rows).
 *
 * Method:
 * - Each size seeds one project's `runs.db` with the store's own row encoding: archived `done`
 *   roots, each with `--workers-per-parent` destroyed workers (`destroy.phase` complete, directory
 *   gone, `worktreePath` kept on the record, as a destroy leaves it), plus `--live-roots` finished
 *   roots whose worktree directories exist. The record sizes default to a busy local project
 *   (2,876 destroyed workers under 396 roots, parents 640 KB and workers 54 KB on average).
 * - The store is opened as `serve` opens it, and `reclaimWorktrees` runs with a claim that refuses
 *   every run: a pass selects and stops there, so nothing is removed and every pass sees the same
 *   rows. `listRunsWithWorktree` is timed on its own as well; the pass includes it.
 * - Times are the median of `--passes` passes, after one warm-up pass.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { prepareBenchmarkEnv } from './benchmark-home.ts';
import type { RunRecord } from '../src/runs/store.ts';

const ownHome = prepareBenchmarkEnv();

const { values } = parseArgs({ options: {
  workers: { type: 'string', default: '100,1000,3000' },
  'workers-per-parent': { type: 'string', default: '7' },
  'parent-kb': { type: 'string', default: '640' },
  'worker-kb': { type: 'string', default: '50' },
  'live-roots': { type: 'string', default: '20' },
  passes: { type: 'string', default: '3' },
  out: { type: 'string' },
} });
const sizes = values.workers.split(',').map(Number);
const perParent = Number(values['workers-per-parent']), parentKb = Number(values['parent-kb']), workerKb = Number(values['worker-kb']);
const liveRoots = Number(values['live-roots']), passes = Number(values.passes);
if (sizes.some(size => !Number.isInteger(size) || size < 0) || !(perParent >= 1) || !(passes >= 1)) throw new Error('--workers takes whole numbers >= 0; --workers-per-parent and --passes take numbers >= 1');

const { RunStore } = await import('../src/runs/store.ts');
const { reclaimWorktrees } = await import('../src/runs/retention.ts');
const { seedRuns } = await import('../src/runs/run-store.testkit.ts');

const pad = (kb: number) => 'x'.repeat(kb * 1024);
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1) + minute * 60_000).toISOString();

/** One project's rows: destroyed worker families, then finished roots that still have a directory. */
function records(workers: number, root: string): RunRecord[] {
  const rows: RunRecord[] = [];
  const parentTask = pad(parentKb), workerTask = pad(workerKb);
  for (let made = 0, family = 0; made < workers; family++) {
    const parentId = randomUUID();
    rows.push(makeRunRecord({ id: parentId, status: 'done', archived: true, task: parentTask, createdAt: at(family * 10), finishedAt: at(family * 10 + 9),
      delegation: { role: 'root', permissions: ['spawn'], receipts: [] } }));
    for (let i = 0; i < perParent && made < workers; i++, made++) {
      const id = randomUUID();
      rows.push(makeRunRecord({ id, status: 'done', archived: true, task: workerTask, createdAt: at(family * 10 + 1), finishedAt: at(family * 10 + 2),
        worktreePath: join(root, '.ai/cezar/worktrees', id), branch: `cez/${id.slice(0, 8)}`,
        delegation: { role: 'worker', permissions: [], parentRunId: parentId,
          workspace: { ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated', path: join(root, '.ai/cezar/worktrees', id), branch: `cez/${id.slice(0, 8)}`, baselineSha: 'a'.repeat(40) },
          destroy: { requestedAt: at(family * 10 + 3), phase: 'complete', remaining: [] } } }));
    }
  }
  for (let i = 0; i < liveRoots; i++) {
    const id = randomUUID(), worktreePath = join(root, '.ai/cezar/worktrees', id);
    mkdirSync(worktreePath, { recursive: true });
    rows.push(makeRunRecord({ id, status: 'done', task: workerTask, createdAt: at(1e6 + i), finishedAt: at(1e6 + i + 1), worktreePath, branch: `cez/${id.slice(0, 8)}` }));
  }
  return rows;
}

const median = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;

const results = [];
for (const workers of sizes) {
  const root = mkdtempSync(join(tmpdir(), 'cez-bench-retention-'));
  try {
    const dataDir = join(root, '.ai/cezar');
    seedRuns(dataDir, records(workers, root));
    const store = RunStore.open(dataDir, { keepLive: true });
    try {
      const pass = async () => { const t = performance.now(); await reclaimWorktrees(root, store, 10, { claim: () => null }); return performance.now() - t; };
      const list = () => { const t = performance.now(); const runs = store.listRunsWithWorktree(); return [performance.now() - t, runs.length] as const; };
      await pass();
      const passMs: number[] = [], listMs: number[] = [];
      let candidates = 0;
      for (let i = 0; i < passes; i++) {
        passMs.push(await pass());
        const [ms, count] = list();
        listMs.push(ms); candidates = count;
      }
      results.push({ workers, parents: Math.ceil(workers / perParent), candidates, listMs: Math.round(median(listMs)), passMs: Math.round(median(passMs)) });
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(`parent ${parentKb} KB, worker ${workerKb} KB, ${perParent} workers per parent, ${liveRoots} live roots, median of ${passes} passes, ${cpus().length} cores, Node ${process.version}`);
console.log('| destroyed workers | parents | rows listed | list ms | pass ms |');
console.log('| ---: | ---: | ---: | ---: | ---: |');
for (const row of results) console.log(`| ${row.workers} | ${row.parents} | ${row.candidates} | ${row.listMs} | ${row.passMs} |`);
if (values.out) writeFileSync(values.out, `${JSON.stringify(results, null, 2)}\n`);
if (ownHome) rmSync(ownHome, { recursive: true, force: true });
process.exit(0);
