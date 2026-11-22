/**
 * Automation lookup benchmark: what the automations list and receipt recovery cost as a project's
 * history grows. The list counts every automation's runs (`countAutomationRuns`), and the Tasks
 * pages ask for that list to name each task's automation; receipt recovery looks runs up by receipt
 * (`findRunIdsByAutomationReceipt`). Run it unchanged before and after a change to either lookup.
 *
 *   npm run bench:automation-lookups -w @wjarka/cezarion
 *   node --import tsx packages/cezar/scripts/benchmark-automation-lookups.ts --runs 1000,4000,10000
 *
 * Flags: --runs (1000,4000,10000) --automations (12) --record-kb (50) --passes (5) --out (a JSON file).
 *
 * Method:
 * - Each size seeds one project's `runs.db` with the store's own row encoding: `--runs` finished
 *   tasks of about `--record-kb` each, one in twenty launched by one of `--automations`
 *   automations. The defaults follow a busy local project: 4,372 runs, 242 of them from 12
 *   automations, 54 KB per record on average.
 * - The store is opened as `serve` opens it. A list is `countAutomationRuns` for every automation;
 *   a recovery is one `findRunIdsByAutomationReceipt` call for three receipts.
 * - Times are the median of `--passes` calls, after one warm-up call.
 */
import { randomUUID } from 'node:crypto';
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { benchAt as at, median, runSizes, withSeededStore } from './benchmark-store-fixture.ts';
import type { RunRecord, RunStore } from '../src/runs/store.ts';

export interface AutomationBenchOptions { runs: number; automations: number; recordKb: number; passes: number }
export interface AutomationBenchRow { runs: number; launched: number; listMs: number; receiptMs: number; counted: number }

function records(options: AutomationBenchOptions): { rows: RunRecord[]; receipts: string[] } {
  const task = 'x'.repeat(options.recordKb * 1024), receipts: string[] = [];
  const rows = Array.from({ length: options.runs }, (_, index) => {
    const launched = index % 20 === 0;
    const receiptId = randomUUID();
    if (launched && receipts.length < 3) receipts.push(receiptId);
    return makeRunRecord({ id: randomUUID(), status: 'done', archived: true, task, createdAt: at(index), finishedAt: at(index + 1),
      ...(launched ? { automation: { automationId: `automation-${index % options.automations}`, automationRevision: 1, receiptId,
        event: 'issue.opened', githubUrl: 'https://github.com/o/r/issues/1' } } : {}) });
  });
  return { rows, receipts };
}

/** Seed one temporary project, open its store and time a list and a recovery. */
export async function measureAutomationLookups(options: AutomationBenchOptions): Promise<AutomationBenchRow> {
  const { rows, receipts } = records(options);
  const ids = Array.from({ length: options.automations }, (_, index) => `automation-${index}`);
  return withSeededStore('cez-bench-automations-', () => rows, async (store: RunStore) => {
    const time = (call: () => unknown) => {
      call();
      const samples: number[] = [];
      for (let i = 0; i < options.passes; i++) { const t = performance.now(); call(); samples.push(performance.now() - t); }
      return Math.round(median(samples));
    };
    const list = () => ids.reduce((sum, id) => sum + store.queries.countAutomationRuns(id), 0);
    return { runs: options.runs, launched: rows.filter(run => run.automation).length, counted: list(),
      listMs: time(list), receiptMs: time(() => store.queries.findRunIdsByAutomationReceipt(receipts)) };
  });
}

export interface AutomationBenchArgs { sizes: number[]; base: Omit<AutomationBenchOptions, 'runs'>; out: string | undefined }

/** The command line as one run's settings; throws on a size or count it cannot use. */
export function parseAutomationBenchArgs(args: string[]): AutomationBenchArgs {
  const { values } = parseArgs({ args, options: {
    runs: { type: 'string', default: '1000,4000,10000' },
    automations: { type: 'string', default: '12' },
    'record-kb': { type: 'string', default: '50' },
    passes: { type: 'string', default: '5' },
    out: { type: 'string' },
  } });
  const sizes = values.runs.split(',').map(Number);
  const base = { automations: Number(values.automations), recordKb: Number(values['record-kb']), passes: Number(values.passes) };
  const whole = (value: number, min: number) => Number.isInteger(value) && value >= min;
  if (!sizes.every(size => whole(size, 1)) || !whole(base.automations, 1) || !whole(base.recordKb, 0) || !whole(base.passes, 1)) {
    throw new Error('--runs, --automations and --passes take whole numbers >= 1; --record-kb takes a whole number >= 0');
  }
  return { sizes, base, out: values.out };
}

/** The result as a Markdown table under one line naming the settings and the host. */
export function formatAutomationTable(base: AutomationBenchArgs['base'], rows: readonly AutomationBenchRow[]): string {
  return [
    `${base.automations} automations, record ${base.recordKb} KB, median of ${base.passes} calls, ${cpus().length} cores, Node ${process.version}`,
    '| runs | launched by an automation | automations list ms | receipt recovery ms |',
    '| ---: | ---: | ---: | ---: |',
    ...rows.map(row => `| ${row.runs} | ${row.launched} | ${row.listMs} | ${row.receiptMs} |`),
  ].join('\n');
}

async function main(): Promise<void> {
  const { sizes, base, out } = parseAutomationBenchArgs(process.argv.slice(2));
  await runSizes(sizes, out, runs => measureAutomationLookups({ ...base, runs }), rows => formatAutomationTable(base, rows));
}

if (import.meta.main) await main();
