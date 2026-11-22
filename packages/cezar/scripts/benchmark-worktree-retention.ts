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
import { mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { benchAt as at, median, runSizes, withSeededStore } from './benchmark-store-fixture.ts';
import { reclaimWorktrees } from '../src/runs/retention.ts';
import { registerBuiltInRunSlots } from '../src/built-in-run-slots.ts';
import type { RunRecord } from '../src/runs/store.ts';

export interface RetentionBenchOptions {
  /** Destroyed workers in the project. */
  workers: number;
  workersPerParent: number;
  parentKb: number;
  workerKb: number;
  /** Finished roots whose worktree directory exists: what a pass can select. */
  liveRoots: number;
  passes: number;
}

export interface RetentionBenchRow { workers: number; parents: number; candidates: number; listMs: number; passMs: number }

const pad = (kb: number) => 'x'.repeat(kb * 1024);

/** One project's rows: destroyed worker families, then finished roots that still have a directory. */
function records(options: RetentionBenchOptions, root: string): RunRecord[] {
  const rows: RunRecord[] = [];
  const parentTask = pad(options.parentKb), workerTask = pad(options.workerKb);
  for (let made = 0, family = 0; made < options.workers; family++) {
    const parentId = randomUUID();
    rows.push(makeRunRecord({ id: parentId, status: 'done', archived: true, task: parentTask, createdAt: at(family * 10), finishedAt: at(family * 10 + 9),
      delegation: { role: 'root', permissions: ['spawn'], receipts: [] } }));
    for (let i = 0; i < options.workersPerParent && made < options.workers; i++, made++) {
      const id = randomUUID(), path = join(root, '.ai/cezar/worktrees', id), branch = `cez/${id.slice(0, 8)}`;
      rows.push(makeRunRecord({ id, status: 'done', archived: true, task: workerTask, createdAt: at(family * 10 + 1), finishedAt: at(family * 10 + 2),
        worktreePath: path, branch,
        delegation: { role: 'worker', permissions: [], parentRunId: parentId,
          workspace: { ownerRunId: id, resourceId: randomUUID(), kind: 'owned-isolated', path, branch, baselineSha: 'a'.repeat(40) },
          destroy: { requestedAt: at(family * 10 + 3), phase: 'complete', remaining: [] } } }));
    }
  }
  for (let i = 0; i < options.liveRoots; i++) {
    const id = randomUUID(), worktreePath = join(root, '.ai/cezar/worktrees', id);
    mkdirSync(worktreePath, { recursive: true });
    rows.push(makeRunRecord({ id, status: 'done', task: workerTask, createdAt: at(1e6 + i), finishedAt: at(1e6 + i + 1), worktreePath, branch: `cez/${id.slice(0, 8)}` }));
  }
  return rows;
}

/** Seed one temporary project, open its store and time `--passes` retention passes. */
export async function measureRetention(options: RetentionBenchOptions): Promise<RetentionBenchRow> {
  return withSeededStore('cez-bench-retention-', root => records(options, root), async (store, root) => {
    const pass = async () => { const t = performance.now(); await reclaimWorktrees(root, store, 10, { claim: () => null }); return performance.now() - t; };
    await pass();
    const passMs: number[] = [], listMs: number[] = [];
    let candidates = 0;
    for (let i = 0; i < options.passes; i++) {
      passMs.push(await pass());
      const t = performance.now();
      candidates = store.listRunsWithWorktree().length;
      listMs.push(performance.now() - t);
    }
    return { workers: options.workers, parents: Math.ceil(options.workers / options.workersPerParent), candidates,
      listMs: Math.round(median(listMs)), passMs: Math.round(median(passMs)) };
  });
}

export interface RetentionBenchArgs { sizes: number[]; base: Omit<RetentionBenchOptions, 'workers'>; out: string | undefined }

/** The command line as one run's settings; throws on a size or count it cannot use. */
export function parseRetentionBenchArgs(args: string[]): RetentionBenchArgs {
  const { values } = parseArgs({ args, options: {
    workers: { type: 'string', default: '100,1000,3000' },
    'workers-per-parent': { type: 'string', default: '7' },
    'parent-kb': { type: 'string', default: '640' },
    'worker-kb': { type: 'string', default: '50' },
    'live-roots': { type: 'string', default: '20' },
    passes: { type: 'string', default: '3' },
    out: { type: 'string' },
  } });
  const sizes = values.workers.split(',').map(Number);
  const base = { workersPerParent: Number(values['workers-per-parent']), parentKb: Number(values['parent-kb']), workerKb: Number(values['worker-kb']),
    liveRoots: Number(values['live-roots']), passes: Number(values.passes) };
  if (sizes.some(size => !Number.isInteger(size) || size < 0) || !(Number.isInteger(base.workersPerParent) && base.workersPerParent >= 1) || !(Number.isInteger(base.passes) && base.passes >= 1)) {
    throw new Error('--workers takes whole numbers >= 0; --workers-per-parent and --passes take whole numbers >= 1');
  }
  return { sizes, base, out: values.out };
}

/** The result as a Markdown table under one line naming the settings and the host. */
export function formatRetentionTable(base: RetentionBenchArgs['base'], rows: readonly RetentionBenchRow[]): string {
  return [
    `parent ${base.parentKb} KB, worker ${base.workerKb} KB, ${base.workersPerParent} workers per parent, ${base.liveRoots} live roots, median of ${base.passes} passes, ${cpus().length} cores, Node ${process.version}`,
    '| destroyed workers | parents | rows listed | list ms | pass ms |',
    '| ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(row => `| ${row.workers} | ${row.parents} | ${row.candidates} | ${row.listMs} | ${row.passMs} |`),
  ].join('\n');
}

async function main(): Promise<void> {
  registerBuiltInRunSlots();
  const { sizes, base, out } = parseRetentionBenchArgs(process.argv.slice(2));
  await runSizes(sizes, out, workers => measureRetention({ ...base, workers }), rows => formatRetentionTable(base, rows));
}

if (import.meta.main) await main();
