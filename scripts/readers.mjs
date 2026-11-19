#!/usr/bin/env node
// The reader sweep of CODE_REVIEW.md § Changing working behavior, as one command:
//
//   node scripts/readers.mjs <name…>              every reader of each name, grouped by tree
//   node scripts/readers.mjs --runner <id> [name…]  also the saved-run readers of a runner id
//   node scripts/readers.mjs -- --old-flag          a name that starts with `-` follows `--`
//   node scripts/readers.mjs --moved <old> <new>    the readers of a moved file's old path, and the
//                                                   JSON pins that name it, to rewrite in the same commit
//
// It searches every tracked and untracked, not ignored, file of the checkout with `git grep`,
// so no tree is left out by hand. A name that holds a `/` is a path: the sweep also searches
// its last segment, without its extension, after a `/`, which finds a reader that imports it
// through a relative specifier (`../../scripts/mock-scenario.mjs` for
// `packages/cezar/scripts/mock-scenario.mjs`). A search cannot find a caller that omits a
// newly required field: the typecheck finds those.
//
// The output is a report. The command exits 1 only when a RUNNER_ID_READERS entry no longer
// matches its file, so the list below gets updated when a reader moves.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The trees a sweep reports even when they hold no hit, so a zero is visible. The first
 *  matching prefix wins; a hit outside them is grouped by its top-level directory. */
export const TREES = [
  'packages/cezar/src',
  'packages/cezar/test',
  'packages/cezar/scripts',
  'packages/contract',
  'packages/api-client',
  'packages/web/src',
  'packages/web/e2e',
  'packages/web/scripts',
  '.github/scripts',
  '.github/workflows',
  'scripts',
  '.ai/scripts',
  '.ai/skills',
];

/**
 * The code that reads a runner id from saved data: run rows, steps, workflow-definition steps,
 * stored list summaries and worker-result snapshots. A text search for the id cannot find most
 * of them, because they read the `runner`, `backend` or `removedRunner` field of any value.
 * AGENT_PROTOCOL.md § Removing a runner names each file; scripts/readers.test.mjs keeps both
 * lists equal and checks that each anchor is still in its file.
 */
export const RUNNER_ID_READERS = [
  { reader: 'Read-time fold: REMOVED_RUNNER_IDS and the row, summary and worker-result upgrades', file: 'packages/cezar/src/runs/legacy-run-rows.ts', anchor: 'REMOVED_RUNNER_IDS' },
  { reader: 'Run row with its steps and workflowDef steps, and the worker-result snapshot, folded on load', file: 'packages/cezar/src/runs/store.ts', anchor: 'upgradeRemovedRunnerResult(' },
  { reader: 'Stored list summary of a settled run', file: 'packages/cezar/src/runs/run-summary-page.ts', anchor: 'upgradeRemovedRunnerSummary(' },
  { reader: 'Record schema: runner, removedRunner, step backend and removedBackend', file: 'packages/contract/src/runs.ts', anchor: 'removedBackend' },
  { reader: 'latestSession and removedRunnerStepAfter: the session for terminal hand-off and Continue', file: 'packages/contract/src/run-predicates.ts', anchor: 'export function latestSession' },
  { reader: 'Usage-limit account holds: the account of the next turn', file: 'packages/cezar/src/workflows/execution-account.ts', anchor: 'latestSession(run)' },
  { reader: 'Queued and interrupted revival', file: 'packages/cezar/src/workflows/run/queued-revival.ts', anchor: 'run.removedRunner' },
  { reader: 'Scheduling of queued runs', file: 'packages/cezar/src/workflows/run-scheduling.ts', anchor: 'run.removedRunner' },
  { reader: 'Start and resume of a saved run', file: 'packages/cezar/src/workflows/run.ts', anchor: 'removedRunner' },
  { reader: 'Continue admission', file: 'packages/cezar/src/workflows/continuation-admission.ts', anchor: 'removedRunnerStepAfter(' },
  { reader: 'Continue provenance by start time', file: 'packages/cezar/src/workflows/run/launch-read-resolver.ts', anchor: 'removedRunnerStepAfter(' },
  { reader: 'Worker execution identity', file: 'packages/cezar/src/delegation/execution-identity.ts', anchor: 'removedRunnerStepAfter(' },
  { reader: 'HTTP Continue and checkout routes', file: 'packages/cezar/src/server/server.ts', anchor: 'run.removedRunner' },
  { reader: 'Cockpit run actions', file: 'packages/web/src/routes/task-thread/run-actions.ts', anchor: 'run.removedRunner' },
  { reader: 'Cockpit agent identity', file: 'packages/web/src/routes/task-thread/run-agent-identity.ts', anchor: 'run.removedRunner' },
  { reader: 'Cockpit continuation provider', file: 'packages/web/src/routes/task-thread/continuation-provider.ts', anchor: 'run.removedRunner' },
  { reader: 'Cockpit task thread notice', file: 'packages/web/src/routes/task-thread/task-thread.tsx', anchor: 'run.removedRunner' },
];

/** The tree a repository path belongs to. */
export function treeOf(path) {
  const segments = path.split('/');
  return TREES.find(tree => path.startsWith(`${tree}/`)) ?? segments.slice(0, segments[0] === 'packages' && segments.length > 2 ? 2 : 1).join('/');
}

/** The relative-specifier form of a path name: `/` and its last segment without an extension.
 *  Undefined for a name without a `/`. */
export function specifierOf(name) {
  if (!name.includes('/')) return undefined;
  const segment = name.replace(/\/+$/, '').split('/').at(-1)?.replace(/\.[^.]+$/, '');
  return segment ? `/${segment}` : undefined;
}

function grep(root, patterns, pathspec = '.') {
  // --no-color and -z keep the output parseable whatever the user's Git config or file names.
  const args = ['grep', '--no-color', '-z', '-n', '-I', '-F', '--untracked', ...patterns.flatMap(pattern => ['-e', pattern]), '--', pathspec];
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    if (error.status === 1) return '';
    throw error;
  }
}

function parseHits(output) {
  return output.split('\n').filter(Boolean).map(line => {
    const [file, number, ...text] = line.split('\0');
    return file && /^\d+$/.test(number ?? '') ? { file, line: Number(number), text: text.join('\0').trim() } : undefined;
  }).filter(Boolean);
}

/** Every reader of one name: its exact hits and, for a path, its relative-specifier hits on
 *  lines the exact search did not find. */
export function searchName(root, name, patterns = [name]) {
  const exact = parseHits(grep(root, patterns));
  const specifier = specifierOf(name);
  const seen = new Set(exact.map(hit => `${hit.file}:${hit.line}`));
  const relative = specifier === undefined ? [] : parseHits(grep(root, [specifier])).filter(hit => !seen.has(`${hit.file}:${hit.line}`));
  return { name, specifier, hits: [...exact.map(hit => ({ ...hit, form: 'exact' })), ...relative.map(hit => ({ ...hit, form: 'specifier' }))] };
}

/** Each RUNNER_ID_READERS entry with whether its file still holds its anchor. */
export function runnerReaders(root) {
  return RUNNER_ID_READERS.map(entry => {
    const path = join(root, entry.file);
    return { ...entry, found: existsSync(path) && readFileSync(path, 'utf8').includes(entry.anchor) };
  });
}

/** Group hits by tree: every TREES entry first, zeros included, then any other tree. */
export function groupByTree(hits) {
  const groups = new Map(TREES.map(tree => [tree, []]));
  for (const hit of hits) {
    const tree = treeOf(hit.file);
    if (!groups.has(tree)) groups.set(tree, []);
    groups.get(tree).push(hit);
  }
  return groups;
}

const MAX_TEXT = 160;

export function formatSearch(result) {
  const files = new Set(result.hits.map(hit => hit.file));
  const lines = [`## ${result.name}: ${result.hits.length} lines in ${files.size} files${result.specifier ? ` (with relative specifier "${result.specifier}")` : ''}`];
  for (const [tree, hits] of groupByTree(result.hits)) {
    lines.push(`${tree}: ${hits.length}`);
    for (const hit of hits) {
      const text = hit.text.length > MAX_TEXT ? `${hit.text.slice(0, MAX_TEXT)}…` : hit.text;
      lines.push(`  ${hit.file}:${hit.line}${hit.form === 'specifier' ? ' [specifier]' : ''}: ${text}`);
    }
  }
  return lines.join('\n');
}

export function formatRunnerReaders(readers) {
  return ['## Saved-run readers of a runner id (AGENT_PROTOCOL.md § Removing a runner)',
    ...readers.map(entry => `${entry.found ? 'ok     ' : 'MISSING'} ${entry.file} — ${entry.reader} (anchor "${entry.anchor}")`)].join('\n');
}

/** The JSON files that name a path: mutant targets and equivalents, the baselines and the lint lists.
 *  Each pins a file, or a function by its file, so a move rewrites them. */
export function searchPins(root, path) {
  return parseHits(grep(root, [path], '*.json'));
}

export function formatPins({ from, to }, hits) {
  const files = new Set(hits.map(hit => hit.file));
  return [`## JSON pins that name ${from}: ${hits.length} lines in ${files.size} files; rewrite each to ${to}`,
    ...hits.map(hit => `  ${hit.file}:${hit.line}: ${hit.text.length > MAX_TEXT ? `${hit.text.slice(0, MAX_TEXT)}…` : hit.text}`),
    'The guards that key on a directory, not a file, are listed in docs/areas/packages.md § Moving a source file.'].join('\n');
}

export function parseArgs(argv) {
  const names = [];
  let runner, moved;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      names.push(...argv.slice(index + 1));
      break;
    } else if (arg === '--runner') {
      runner = argv[index + 1];
      index += 1;
      if (!runner || runner.startsWith('-')) throw new Error('--runner needs a runner id');
    } else if (arg === '--moved') {
      const [from, to] = argv.slice(index + 1, index + 3);
      index += 2;
      if (!from || !to || from.startsWith('-') || to.startsWith('-')) throw new Error('--moved needs <old-path> <new-path>');
      moved = { from, to };
      names.push(from);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      names.push(arg);
    }
  }
  if (!names.length && runner === undefined) throw new Error('Usage: node scripts/readers.mjs [--runner <id>] [--moved <old-path> <new-path>] <name…>');
  return { names, runner, ...(moved ? { moved } : {}) };
}

/** The report for one invocation, and its exit code. */
export function sweep(root, { names, runner, moved }) {
  const sections = [];
  let code = 0;
  if (runner !== undefined) {
    const readers = runnerReaders(root);
    if (readers.some(entry => !entry.found)) code = 1;
    sections.push(formatRunnerReaders(readers));
    sections.push(formatSearch(searchName(root, runner, [`'${runner}'`, `"${runner}"`, `\`${runner}\``])));
  }
  if (moved) sections.push(formatPins(moved, searchPins(root, moved.from)));
  for (const name of names) sections.push(formatSearch(searchName(root, name)));
  return { report: sections.join('\n\n'), code };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const { report, code } = sweep(root, options);
  process.stdout.write(`${report}\n`);
  process.exitCode = code;
}
