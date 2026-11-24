#!/usr/bin/env node
// Adds a sixth built-in runner to a scratch clone, only in the places a new built-in runner may
// touch (hearsay-tools/squawk#3900): its folder `packages/cezar/src/runners/<id>/`, its mock script
// and that script's data files in `packages/cezar/scripts/`, one line in
// `packages/cezar/src/runners/built-in.ts` and its id in `packages/cezar/src/runners/ids.ts`.
// The result is never committed. Two modes:
//
//   node .ai/scripts/simulate-sixth-runner.mjs <scratch clone>
//   node .ai/scripts/simulate-sixth-runner.mjs --complete <scratch clone>
//
// The first mode (the four places) adds `sixth`: the test-only fixture runner (`runners/fixture/`)
// under production names, with the mock script `mock-sixth-runner.mjs`; its `mock.testkit.ts`,
// when the fixture has one, becomes `mock.ts`. It is an incomplete runner: the guard tests must
// name each missing piece inside the four places.
//
// `--complete` adds `hexacode`: a complete runner, every file of `runners/opencode/`, its mock
// scripts `mock-opencode-*`, its shipped scripts `opencode-*` (the task-scope plugin) and its
// skill data `mock-skill-data/opencode.mjs`, with each name
// renamed (identifiers, ids, env variables, binary and file names). `hexacode` cannot collide: no
// file of the repository holds it, it holds no other runner's id, and it has the length of
// `opencode`, so no line changes length. A relative path or an imported name that a copied file
// takes from outside the copied files keeps its `opencode` spelling: the copy shares that module,
// and the script prints each one on stderr, since a new runner would need its own.
//
// It refuses a path that shares this repository's git directory (the main checkout or one of its
// worktrees) and a checkout with uncommitted changes. Make the clone with
// `git clone <this repo> <dir> && git -C <dir> checkout <commit>`, then run this script on it.
// It prints the roster-reading test files: every test file that imports `runners/ids.ts`,
// `runners/built-in.ts` or `core/register-all-runners.testkit.ts`, the closure guards and the
// new runner's own test files.
//
// Exit check (the epic's criterion 7): in the clone, run `pnpm install --frozen-lockfile`, then
// `npm run typecheck -w @wjarka/cezarion`, then the printed test files. The complete runner
// passes them all; the four-places runner fails only by naming a missing piece. Run the files
// through Squeal in the clone: `squeal start`, `squeal run tests <files> --wait 60000`, then
// `squeal status --wait 60000 <files>` until it gives a verdict. That is how hearsay-tools/squawk#3900's D2a ran it. Without
// Squeal, CI's command runs the same files: `npm test -- <files>`.
// The lint rule `mock-scenario-boundary` flags the copied fixture mock: a built-in runner's mock
// script must import `mock-scenario.mjs` (AGENT_PROTOCOL.md §10 item 8). The exit check leaves lint out.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SRC = 'packages/cezar/src';
const SCRIPTS = 'packages/cezar/scripts';
const REGISTRATION = [`${SRC}/runners/built-in.ts`, `${SRC}/runners/ids.ts`];
/** The four places of the `sixth` runner, as path prefixes relative to the checkout. */
export const FOUR_PLACES = [`${SRC}/runners/sixth/`, `${SCRIPTS}/mock-sixth-runner.mjs`, ...REGISTRATION];
/** The runner that `--complete` copies, and the id of its copy. */
export const COMPLETE_SOURCE = 'opencode';
export const COMPLETE_ID = 'hexacode';
/** The places of the complete runner: its folder, its mock and shipped scripts, its skill data and its registration. */
export const COMPLETE_PLACES = [`${SRC}/runners/${COMPLETE_ID}/`, `${SCRIPTS}/mock-${COMPLETE_ID}-`, `${SCRIPTS}/${COMPLETE_ID}-`,
  `${SCRIPTS}/mock-skill-data/${COMPLETE_ID}.mjs`, ...REGISTRATION];
const ROSTER_MODULES = new Set(['runners/ids', 'runners/built-in', 'core/register-all-runners.testkit']);
const GUARD_TESTS = [`${SRC}/runner-class-rule.test.ts`, `${SRC}/core/harness-parity-closure.test.ts`, `${SRC}/vitest-setup-closure.test.ts`];

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function commonDir(checkout) {
  return realpathSync(resolve(checkout, git(checkout, ['rev-parse', '--git-common-dir']).trim()));
}

/** Why the script must not run on `target`, or undefined when it may. */
export function refusal(target, repo = REPO) {
  if (!existsSync(target)) return `${target} does not exist`;
  let common;
  try { common = commonDir(target); } catch { return `${target} is not a git checkout`; }
  if (common === commonDir(repo)) return `${target} shares this repository's git directory (the main checkout or one of its worktrees); use a separate clone`;
  if (git(target, ['status', '--porcelain'])) return `${target} has uncommitted changes`;
  return undefined;
}

/** Production names: the fixture's `*.testkit.ts` data modules become plain modules. */
function rename(text) {
  return text.replaceAll('FixtureAdapter', 'SixthRunner').replaceAll('FIXTURE', 'SIXTH')
    .replaceAll('Fixture', 'Sixth').replaceAll('fixture', 'sixth')
    .replaceAll("'./data.testkit.ts'", "'./data.ts'").replaceAll("'./mock.testkit.ts'", "'./mock.ts'");
}

function replaceOnce(text, find, replacement) {
  if (!text.includes(find)) throw new Error(`expected text not found: ${find.slice(0, 80)}`);
  return text.replace(find, replacement);
}

/** `facts.ts`, `data.ts` and `extra-tools.ts` from the fixture runner's data file. */
function dataFiles(fixtureData) {
  const data = rename(fixtureData);
  const facts = /\/\*\* What the sixth mock's wire can do.*?as const satisfies RunnerFacts;\n/s.exec(data)?.[0];
  if (!facts) throw new Error('the fixture data holds no FIXTURE_FACTS block');
  const rest = replaceOnce(replaceOnce(data, facts, "export { SIXTH_FACTS } from './facts.ts';\n"),
    "import type { RunnerFacts } from '../../core/runner-facts.ts';\n", '');
  return {
    'facts.ts': `import type { RunnerFacts } from '../../core/runner-facts.ts';\n\n${facts}`,
    'data.ts': rest,
    'extra-tools.ts': "/** The sixth runner's extra tools. Data only. */\nexport const SIXTH_EXTRA_TOOLS: readonly string[] = [];\n",
  };
}

function definitionFile(fixtureDefinition) {
  let text = rename(fixtureDefinition);
  text = replaceOnce(text, "'./sixth-adapter.testkit.ts'", "'./sixth-runner.ts'");
  text = replaceOnce(text, '  extraTools: [],\n', '  extraTools: SIXTH_EXTRA_TOOLS,\n');
  return replaceOnce(text, "} from './data.ts';\n", "} from './data.ts';\nimport { SIXTH_EXTRA_TOOLS } from './extra-tools.ts';\n");
}

const UNUSED_TEST_LINES = [
  "import { join } from 'node:path';\n", "import { writeFileSync } from 'node:fs';\n",
  "import { afterEach, describe, expect, it, vi } from 'vitest';\n",
  "import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';\n",
  "import { harnessAdapter } from '../../core/harness-parity-core.testkit.ts';\n",
  "import { RUNNER_FACTS } from '../../core/runner-facts.ts';\n",
  "import { setupMonitoringFixture, waitForProduct } from '../../workflows/run-fixture.testkit.ts';\n",
  "import { BUILT_IN_RUNNER_IDS } from '../ids.ts';\n",
];

/** The per-runner parity file the closure guard requires: the fixture test's baseline seam rows. */
function parityTestFile(fixtureTest) {
  let text = fixtureTest.replace(/describe\('the fixture runner in the registry'.*?\n\}\);\n/s, '')
    .replace(/describe\('a task on the fixture runner'.*/s, '');
  for (const line of UNUSED_TEST_LINES) text = replaceOnce(text, line, '');
  text = text.replace(/import \{ FIXTURE_BIN_ENV \} from '\.\/[a-z]+\.testkit\.ts';\n/, '');
  text = replaceOnce(text, "import { knownRunnerIds, registeredRunners, resolveRunnerId } from '../../core/runner-registry.ts';\n",
    '');
  return replaceOnce(rename(text), "'./definition.testkit.ts'", "'./definition.ts'");
}

/** Add the sixth runner to `target` in the four places. */
export function addSixthRunner(target) {
  const read = (path) => readFileSync(join(target, path), 'utf8');
  const fixture = `${SRC}/runners/fixture`;
  const folder = join(target, SRC, 'runners/sixth');
  mkdirSync(folder);
  const files = {
    ...dataFiles(read(`${fixture}/data.testkit.ts`)),
    'sixth-runner.ts': rename(read(`${fixture}/fixture-adapter.testkit.ts`)),
    'definition.ts': definitionFile(read(`${fixture}/definition.testkit.ts`)),
    'harness-sixth-startup-parity.test.ts': parityTestFile(read(`${fixture}/fixture-runner.test.ts`)),
    ...(existsSync(join(target, fixture, 'mock.testkit.ts')) ? { 'mock.ts': rename(read(`${fixture}/mock.testkit.ts`)) } : {}),
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  copyFileSync(join(target, SCRIPTS, 'mock-fixture-runner.mjs'), join(target, SCRIPTS, 'mock-sixth-runner.mjs'));
  register(target, 'sixth');
}

/** Add runner `id` after the last built-in runner in `runners/built-in.ts` and `runners/ids.ts`. */
function register(target, id) {
  const read = (path) => readFileSync(join(target, path), 'utf8');
  const [builtIn, ids] = REGISTRATION;
  writeFileSync(join(target, builtIn), replaceOnce(replaceOnce(read(builtIn),
    "import { ompRunner } from './omp/definition.ts';\n", `import { ompRunner } from './omp/definition.ts';\nimport { ${id}Runner } from './${id}/definition.ts';\n`),
  '];', `, ${id}Runner];`));
  writeFileSync(join(target, ids), replaceOnce(read(ids), '];', `, '${id}'];`));
}

const COMPLETE_SPELLINGS = [['opencode', 'hexacode'], ['Opencode', 'Hexacode'], ['OpenCode', 'HexaCode'], ['OPENCODE', 'HEXACODE'], ['openCode', 'hexaCode']];
const SOURCE_NAME = new RegExp(COMPLETE_SOURCE, 'i');

/** The checkout-relative files that `--complete` copies: the runner folder, its mock and shipped scripts and its skill data. */
function completeSources(target) {
  const folder = `${SRC}/runners/${COMPLETE_SOURCE}`;
  const runnerFiles = readdirSync(join(target, folder), { recursive: true, encoding: 'utf8' })
    .filter(file => statSync(join(target, folder, file)).isFile()).map(file => `${folder}/${file}`);
  const scripts = readdirSync(join(target, SCRIPTS)).filter(file => file.startsWith(`mock-${COMPLETE_SOURCE}-`) || file.startsWith(`${COMPLETE_SOURCE}-`))
    .map(file => `${SCRIPTS}/${file}`);
  return [...runnerFiles, ...scripts, `${SCRIPTS}/mock-skill-data/${COMPLETE_SOURCE}.mjs`].sort();
}

function renameComplete(text) {
  return COMPLETE_SPELLINGS.reduce((result, [from, to]) => result.replaceAll(from, to), text);
}

const IMPORT_CLAUSE = /\b(?:import|export)\s+(?:type\s+)?([^;'"]*?)\s+from\s+['"]([^'"]+)['"]/gs;
const DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)\s*\)\s*\.([\w$]+)/g;
const RELATIVE_STRING = /(['"`])(\.\.?\/[^'"`\s]*)\1/g;

/** The spellings in `text` (the copied file `path`) that name something outside the copied files `copied`: relative paths, and the names imported from them. */
function outsideReferences(path, text, copied) {
  const outside = (spec) => spec.startsWith('.') && !copied.has(posix.join(posix.dirname(path), spec));
  const kept = new Set();
  for (const [, quote, spec] of text.matchAll(RELATIVE_STRING)) if (SOURCE_NAME.test(spec) && outside(spec)) kept.add(`${quote}${spec}${quote}`);
  for (const [, clause, spec] of text.matchAll(IMPORT_CLAUSE)) {
    if (!outside(spec)) continue;
    for (const [name] of clause.matchAll(/[\w$]+/g)) if (SOURCE_NAME.test(name)) kept.add(name);
  }
  for (const [, spec, name] of text.matchAll(DYNAMIC_IMPORT)) if (outside(spec) && SOURCE_NAME.test(name)) kept.add(name);
  return [...kept];
}

/** `text` renamed, except the spellings in `kept`. */
function renameExcept(text, kept) {
  if (!kept.length) return renameComplete(text);
  const parts = text.split(new RegExp(`(${kept.map(word => /^\w/.test(word) ? `\\b${RegExp.escape(word)}\\b` : RegExp.escape(word)).join('|')})`));
  return parts.map((part, index) => index % 2 ? part : renameComplete(part)).join('');
}

/**
 * Add the complete runner `hexacode` to `target`: every copied file under its renamed path, with
 * its names renamed. Returns what the copy still takes from outside the copied files, as
 * `<copied path>: <spelling>`.
 */
export function addCompleteRunner(target) {
  const sources = completeSources(target);
  const copied = new Set(sources);
  const shared = [];
  for (const path of sources) {
    const text = readFileSync(join(target, path), 'utf8');
    const kept = outsideReferences(path, text, copied);
    const renamed = renameExcept(text, kept);
    const leftover = kept.reduce((rest, word) => rest.replaceAll(word, ''), renamed);
    if (SOURCE_NAME.test(leftover)) throw new Error(`${path}: a spelling of ${COMPLETE_SOURCE} is left after the rename`);
    const destination = join(target, renameComplete(path));
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, renamed);
    chmodSync(destination, statSync(join(target, path)).mode);
    shared.push(...kept.map(word => `${path}: ${word}`));
  }
  register(target, COMPLETE_ID);
  return shared;
}

/** The changed paths of `target` outside `places`; empty after `addSixthRunner` (or `addCompleteRunner` with `COMPLETE_PLACES`). */
export function outsideFourPlaces(target, places = FOUR_PLACES) {
  return git(target, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
    .map(line => line.slice(3)).filter(path => !places.some(place => path === place || path.startsWith(place)));
}

/** Whether `source`, written in the `src`-relative `file`, imports one of the roster modules. */
function importsRoster(file, source) {
  const specifiers = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]+)['"]/g)].map(match => match[1]);
  return specifiers.some(specifier => ROSTER_MODULES.has(posix.join(posix.dirname(file), specifier).replace(/\.(ts|js)$/, '')));
}

/** The roster-reading test files of `target` and the test files of runner `id`, repository-relative and sorted. */
export function rosterTests(target, id = 'sixth') {
  const src = join(target, SRC);
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.test.ts'))
    .filter(file => importsRoster(file, readFileSync(join(src, file), 'utf8')) || file.startsWith(`runners/${id}/`))
    .map(file => `${SRC}/${file}`);
  return [...new Set([...files, ...GUARD_TESTS])].sort();
}

function main(argv) {
  const complete = argv[0] === '--complete';
  const args = complete ? argv.slice(1) : argv;
  if (args.length !== 1) throw new Error('usage: node .ai/scripts/simulate-sixth-runner.mjs [--complete] <scratch clone>');
  const target = resolve(args[0]);
  const refused = refusal(target);
  if (refused) throw new Error(refused);
  const shared = complete ? addCompleteRunner(target) : (addSixthRunner(target), []);
  const outside = outsideFourPlaces(target, complete ? COMPLETE_PLACES : FOUR_PLACES);
  if (outside.length) throw new Error(`changed outside the runner's places: ${outside.join(', ')}`);
  for (const line of shared) process.stderr.write(`shared with ${COMPLETE_SOURCE}: ${line}\n`);
  process.stdout.write(`${rosterTests(target, complete ? COMPLETE_ID : 'sixth').join('\n')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`simulate-sixth-runner: ${error.message}\n`);
    process.exitCode = 1;
  }
}
