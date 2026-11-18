// Path rules for the changed-test selection in scripts/test-changed.mjs.
// Each changed path is configuration (full suite), source (import graph), a
// snapshot (its test), an input a declared test reads (that test), an input no
// Vitest test reads (nothing), or unmapped (full suite). Declared readers come
// from squeal.config.json `inputs`, the table Squeal's own selection uses.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, matchesGlob, posix } from 'node:path';

// The four unit projects' include patterns (packages/*/vitest.config.ts).
export const VITEST_TEST = 'packages/{api-client,cezar,contract,web}/src/**/*.test.{ts,tsx}';

// Paths that no Vitest test reads and no Vitest run loads. A Vitest test that
// reads one is declared in squeal.config.json `inputs`, and
// scripts/test-inputs.test.mjs fails when an undeclared reader appears. The
// files the Vitest configuration loads are configuration first.
export const NO_VITEST_READER = [
  '.github/mutants/**', '.github/workflows/**', '.github/scripts/**', '.github/cockpit-test-durations.json',
  '.ai/skills/**', 'scripts/*.test.mjs',
];

// Inputs every Vitest run loads: manifests, the lockfile, TypeScript and Vitest
// configuration. The files these configurations import are added by a walk.
const CONFIGURATION = [
  'package.json', 'packages/*/package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.node-version',
  '**/tsconfig*.json', '**/vitest.config.*', '**/vitest.setup.*', '**/vite.config.*',
];
const CONFIGURATION_ROOTS = [
  'vitest.config.ts',
  ...['api-client', 'cezar', 'contract', 'web'].flatMap(name => [`packages/${name}/vitest.config.ts`, `packages/${name}/vitest.setup.ts`]),
];

// Ordinary TS/JS source that Vitest's import graph covers. Fixtures, snapshots,
// test directories and vite/vitest/setup inputs are not graph members.
export function isSource(path) {
  return /^packages\/(?:cezar|web|api-client)\/src\/.+\.(?:ts|tsx|js|jsx|mjs)$/.test(path)
    && !/(?:^|\/)(?:__fixtures__|fixtures|__snapshots__|test)(?:\/|$)/.test(path)
    && !/(?:^|\/)(?:vitest|vite|setup)[^/]*\.[cm]?[jt]s$/.test(path);
}

// Printable ASCII without quotes or backslashes: avoids Git's quoted-filename ambiguity.
const isPlain = path => /^[\x21-\x7e]+$/.test(path) && !/["\\]/.test(path);

const snapshotTest = path => /^(packages\/.+)\/__snapshots__\/([^/]+\.test\.tsx?)\.snap$/.exec(path)?.slice(1).join('/');

export function readInputs(cwd) {
  const file = join(cwd, 'squeal.config.json');
  if (!existsSync(file)) return [];
  return inputRows(JSON.parse(readFileSync(file, 'utf8')).inputs);
}

const inputRows = (inputs = {}) => Object.entries(inputs).map(([test, globs]) => ({ test, globs }));

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function resolveImport(cwd, from, specifier) {
  let target;
  if (specifier.startsWith('.')) target = posix.join(posix.dirname(from), specifier);
  else if (specifier.startsWith('@/') && from.startsWith('packages/web/')) target = `packages/web/src/${specifier.slice(2)}`;
  else return null;
  const stem = target.replace(/\.(?:js|mjs|cjs)$/, '');
  const candidates = [target, `${stem}.ts`, `${stem}.tsx`, `${target}.ts`, `${target}.tsx`, `${target}.mjs`, `${target}.js`, `${target}/index.ts`];
  return { file: candidates.find(candidate => existsSync(join(cwd, candidate))), candidates };
}

// The local files the Vitest configuration and setup files import, transitively.
export function configurationClosure(cwd) {
  const seen = new Set();
  const queue = CONFIGURATION_ROOTS.filter(path => existsSync(join(cwd, path)));
  while (queue.length) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    for (const [, specifier] of readFileSync(join(cwd, path), 'utf8').matchAll(IMPORT)) {
      const target = resolveImport(cwd, path, specifier);
      if (target?.file) { if (!seen.has(target.file)) queue.push(target.file); }
      // A deleted import is still configuration: every path it could have been stays in the set.
      else if (target) for (const candidate of target.candidates) seen.add(candidate);
    }
  }
  return seen;
}

const describeFull = list => `${list[0][0]}: ${list[0][1]}${list.length > 1 ? ` (+${list.length - 1} more)` : ''}`;

// One path's rule: `full` names why it needs the full suite; otherwise
// `source` marks an import-graph member and `tests` lists the tests it selects.
function classifyPath(path, { inputs, configuration }) {
  if (!isPlain(path)) return { full: 'Unusual path' };
  const vitest = inputs.filter(({ test }) => matchesGlob(test, VITEST_TEST));
  const readers = vitest.filter(({ globs }) => globs.some(glob => matchesGlob(path, glob))).map(({ test }) => test);
  // Source a setup file imports keeps its import-graph selection, as before.
  if (isSource(path)) return { source: true, tests: readers };
  if (configuration.has(path) || CONFIGURATION.some(glob => matchesGlob(path, glob))) return { full: 'Vitest configuration input' };
  const snapshot = snapshotTest(path);
  if (snapshot && matchesGlob(snapshot, VITEST_TEST)) return { tests: [snapshot, ...readers] };
  // A baseline selects its readers only when a test declares the baseline by its exact
  // path: a wildcard such as packages/*/src/**/*.json also matches baselines that test never reads.
  if (path.endsWith('.baseline.json')) {
    const declared = vitest.filter(({ globs }) => globs.includes(path)).map(({ test }) => test);
    if (declared.length) return { tests: declared };
  }
  if (path.startsWith('packages/')) return { full: 'Package input outside the import graph' };
  if (readers.length || NO_VITEST_READER.some(glob => matchesGlob(path, glob))) return { tests: readers };
  return { full: 'Unmapped input' };
}

// Every TS/JS file under packages/*/src; Git's `*` crosses directories.
export const SOURCE_PATHSPECS = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'].map(extension => `packages/*/src/*.${extension}`);

// Package files that name one of `paths` as `/<name>.`, `/<name>'` or `/<name>"`: an
// import, re-export or vi.mock path. A text match, so a shared name over-selects.
function namers(cwd, paths) {
  const patterns = paths.flatMap(path => {
    const name = posix.basename(path).replace(/\.[^.]+$/, '');
    return ['.', "'", '"'].flatMap(end => ['-e', `/${name}${end}`]);
  });
  try {
    return execFileSync('git', ['grep', '-l', '--untracked', '-F', ...patterns, '--', ...SOURCE_PATHSPECS],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).split('\n').filter(Boolean);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

// A walk this wide selects most of the suite anyway: the caller runs it all.
export const IMPORTER_WALK_LIMIT = 300;

// The Vitest tests that reach one of `modules` through a chain of files that name the
// next one, directly or through helpers. Returns null when the walk passes
// IMPORTER_WALK_LIMIT modules. Vitest's import graph has no node for a deleted file,
// so its unchanged importers would otherwise drop out of the selection.
export function testsReaching(cwd, modules) {
  const tests = new Set();
  const seen = new Set(modules);
  let frontier = modules;
  while (frontier.length) {
    const next = [];
    for (const file of namers(cwd, frontier)) {
      if (matchesGlob(file, VITEST_TEST)) tests.add(file);
      else if (!seen.has(file)) { seen.add(file); next.push(file); }
    }
    if (seen.size > IMPORTER_WALK_LIMIT) return null;
    frontier = next;
  }
  return [...tests].sort();
}

// Classifies changed, non-docs paths. A path may be deleted: deleted source
// selects its changed importers through the import graph and its unchanged ones,
// direct or through helpers, through testsReaching.
export function classify(paths, cwd) {
  const context = { inputs: readInputs(cwd), configuration: configurationClosure(cwd) };
  const sources = [];
  const tests = new Set();
  const full = [];
  for (const path of paths) {
    const rule = classifyPath(path, context);
    if (rule.full) full.push([rule.full, path]);
    if (rule.source) sources.push(path);
    for (const test of rule.tests ?? []) tests.add(test);
  }
  if (full.length) return { full: describeFull(full) };
  const deleted = sources.filter(path => !existsSync(join(cwd, path)));
  const reaching = deleted.length ? testsReaching(cwd, deleted) : [];
  if (!reaching) return { full: `Deleted source with more than ${IMPORTER_WALK_LIMIT} transitive importers: ${deleted[0]}` };
  for (const test of reaching) tests.add(test);
  return { sources, tests: [...tests].sort() };
}

// Keeps declared tests that exist, so a stale declaration selects nothing.
export const existingTests = (cwd, tests) => tests.filter(test => existsSync(join(cwd, test)));

/**
 * The root node:test files that `paths` select, as Squeal selects them: a changed test file
 * itself, and each test whose squeal.config.json `inputs` row (a file or a glob of files) has a
 * glob matching a changed path. `argv` is the root node:test project's Node arguments; a config
 * without a root project selects nothing.
 */
export function nodeTestReaders(paths, cwd) {
  const file = join(cwd, 'squeal.config.json');
  const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const project = (config.nodeTest ?? []).find(entry => !entry.cwd);
  if (!project) return { argv: [], files: [] };
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }).split('\0');
  const tests = listed.filter(path => project.include.some(glob => matchesGlob(path, glob)) && existsSync(join(cwd, path)));
  // One read of the configuration: the project and the input rows come from the same snapshot.
  const rows = inputRows(config.inputs).filter(({ globs }) => paths.some(path => globs.some(glob => matchesGlob(path, glob))));
  const files = tests.filter(test => paths.includes(test) || rows.some(row => matchesGlob(test, row.test)));
  return { argv: project.argv ?? [], files: [...new Set(files)].sort() };
}
