import { existsSync } from 'node:fs';
import { compareToBaseline, readBaseline, shrinkBaseline, tally, type BaselineEntry, type BaselineOptions } from './wait-baseline.ts';
import { baselineMode, printLowered, type BaselineMode } from './baseline-mode.ts';
import { baselinePath as unitBaselinePath, srcDir as unitSrcDir, scanTree, unitBaseline } from './unit-wait-discipline.ts';
import { relative } from 'node:path';
import { baselines, scannedFiles, scanSuite, srcDir } from './server-wait-baseline.ts';
import { repoRoot } from './source-rule.ts';

/**
 * The files a baseline's entries can count: the ones it names. Only those can make an entry stale, so the
 * check reads them alone. A baseline that does not exist yet is written once from the whole suite.
 */
const namedFiles = (path: string, files: readonly string[]): string[] => {
  if (!existsSync(path)) return [...files];
  const named = new Set(readBaseline(path).map(entry => entry.file));
  return files.filter(file => named.has(file));
};

/**
 * Bring a baseline down to `actual` as `mode` allows (`lint/baseline-mode.ts`) and return what is still stale.
 * `write` also writes a missing baseline; `lower` lowers an existing one and says so; `report` writes nothing.
 */
function ratchet<Rule extends string>(actual: BaselineEntry<Rule>[], baseline: BaselineOptions, mode: BaselineMode, notify: (line: string) => void): BaselineEntry<Rule>[] {
  const before = compareToBaseline(actual, readBaseline<Rule>(baseline.path)).stale;
  if (mode === 'write' || (mode === 'lower' && before.length > 0)) shrinkBaseline(actual, baseline);
  if (mode === 'lower' && before.length > 0) notify(`${relative(repoRoot, baseline.path)}: ${before.length} stale entr${before.length === 1 ? 'y' : 'ies'} lowered or dropped. Commit the baseline`);
  return mode === 'report' ? before : compareToBaseline(actual, readBaseline<Rule>(baseline.path)).stale;
}

/** Whole-suite guarantees formerly held by the server unit suite's repository cases. */
export function serverWaitProblems(mode = baselineMode(process.env.TEST_WAIT_DISCIPLINE_UPDATE === '1'), dir = srcDir, lists = baselines, notify = printLowered): string[] {
  const files = scannedFiles(dir);
  const problems: string[] = [];
  if (files.length <= 300 || !files.includes('core/harness-parity.testkit.ts')
    || files.some(file => file.startsWith('test-wait-discipline.') || file.includes('__fixtures__/') || file.includes('node_modules/'))) {
    problems.push('packages/cezar/src:1:1 cez/test-wait-discipline: scan scope changed; scan every test and testkit except the scanner fixtures, node_modules and __fixtures__ (AGENTS.md § Validation)');
  }
  for (const baseline of lists) {
    const actual = tally(scanSuite(dir, namedFiles(baseline.path, files)).filter(site => baseline.rules.includes(site.rule)));
    for (const entry of ratchet(actual, baseline, mode, notify)) {
      problems.push(`${relative(repoRoot, baseline.path)}:1:1 cez/test-wait-discipline: stale entry ${entry.file} [${entry.rule}] ×${entry.count}: ${entry.site}. Baseline entries no longer found; run npm run lint locally, which shrinks ${relative(repoRoot, baseline.path)}, and commit it`);
    }
  }
  return problems;
}

/** The cockpit baseline ratchet, separate from the host's asyncUtilTimeout test. */
export function unitWaitProblems(mode = baselineMode(process.env.UNIT_WAIT_DISCIPLINE_UPDATE === '1'), dir = unitSrcDir, path = unitBaselinePath, notify = printLowered): string[] {
  const named = existsSync(path) ? new Set(readBaseline(path).map(entry => entry.file)) : undefined;
  const actual = tally(scanTree(dir, dir, named));
  return ratchet(actual, { ...unitBaseline, path }, mode, notify).map(entry =>
    `${relative(repoRoot, path)}:1:1 cez/unit-wait-discipline: stale entry ${entry.file} [${entry.rule}] x${entry.count}: ${entry.site}. Baseline entries no longer found; run npm run lint locally, which shrinks ${relative(repoRoot, path)}, and commit it`);
}
