#!/usr/bin/env node
// Adds a sixth built-in runner, `sixth`, to a scratch clone, in the four places a new built-in
// runner may touch (hearsay-tools/squawk#3900): its folder `packages/cezar/src/runners/sixth/`,
// its mock script `packages/cezar/scripts/mock-sixth-runner.mjs`, one line in
// `packages/cezar/src/runners/built-in.ts` and its id in `packages/cezar/src/runners/ids.ts`.
// The runner is the test-only fixture runner (`runners/fixture/`) under production names. The
// result is never committed.
//
//   node .ai/scripts/simulate-sixth-runner.mjs <scratch clone>
//
// It refuses a path that shares this repository's git directory (the main checkout or one of its
// worktrees) and a checkout with uncommitted changes. Make the clone with
// `git clone <this repo> <dir> && git -C <dir> checkout <commit>`, then run this script on it.
// It prints the roster-reading test files: every test file that imports `runners/ids.ts`,
// `runners/built-in.ts` or `core/register-all-runners.testkit.ts`, the closure guards and the
// sixth runner's own parity file.
//
// Exit check (the epic's criterion 7): in the clone, run `pnpm install --frozen-lockfile`, then
// `npm run typecheck -w @wjarka/cezarion`, then the printed test files; all pass. Run the files
// through Squeal in the clone: `squeal start`, `squeal run tests <non-parity files> --wait 60000`
// and `squeal run run-loop <*parity* files> --wait 60000`, then `squeal status --wait 60000
// <files>` until it gives a verdict. That is how hearsay-tools/squawk#3900's D2a ran it. Without
// Squeal, CI's command runs the same files: `npm test -- <files>`.
// The lint rule `mock-scenario-boundary` flags the copied mock: a built-in runner's mock script
// must import `mock-scenario.mjs` (AGENT_PROTOCOL.md §10 item 8). The exit check leaves lint out.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const SRC = 'packages/cezar/src';
const SCRIPTS = 'packages/cezar/scripts';
/** The four places, as path prefixes relative to the checkout. */
export const FOUR_PLACES = [`${SRC}/runners/sixth/`, `${SCRIPTS}/mock-sixth-runner.mjs`, `${SRC}/runners/built-in.ts`, `${SRC}/runners/ids.ts`];
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

function rename(text) {
  return text.replaceAll('FixtureAdapter', 'SixthRunner').replaceAll('FIXTURE', 'SIXTH')
    .replaceAll('Fixture', 'Sixth').replaceAll('fixture', 'sixth');
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
  let text = rename(fixtureDefinition).replaceAll("'./data.testkit.ts'", "'./data.ts'");
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
  "import { BUILT_IN_RUNNER_IDS } from '../ids.ts';\n", "import { FIXTURE_BIN_ENV } from './data.testkit.ts';\n",
];

/** The per-runner parity file the closure guard requires: the fixture test's baseline seam rows. */
function parityTestFile(fixtureTest) {
  let text = fixtureTest.replace(/describe\('the fixture runner in the registry'.*?\n\}\);\n/s, '')
    .replace(/describe\('a task on the fixture runner'.*/s, '');
  for (const line of UNUSED_TEST_LINES) text = replaceOnce(text, line, '');
  text = replaceOnce(text, "import { knownRunnerIds, registerRunner, registeredRunners, resolveRunnerId } from '../../core/runner-registry.ts';\n",
    "import { registerRunner } from '../../core/runner-registry.ts';\n");
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
    'sixth-runner.ts': rename(read(`${fixture}/fixture-adapter.testkit.ts`)).replaceAll("'./data.testkit.ts'", "'./data.ts'"),
    'definition.ts': definitionFile(read(`${fixture}/definition.testkit.ts`)),
    'harness-sixth-startup-parity.test.ts': parityTestFile(read(`${fixture}/fixture-runner.test.ts`)),
  };
  for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
  copyFileSync(join(target, SCRIPTS, 'mock-fixture-runner.mjs'), join(target, SCRIPTS, 'mock-sixth-runner.mjs'));
  const builtIn = `${SRC}/runners/built-in.ts`;
  writeFileSync(join(target, builtIn), replaceOnce(replaceOnce(read(builtIn),
    "import { ompRunner } from './omp/definition.ts';\n", "import { ompRunner } from './omp/definition.ts';\nimport { sixthRunner } from './sixth/definition.ts';\n"),
  'piRunner, ompRunner];', 'piRunner, ompRunner, sixthRunner];'));
  const ids = `${SRC}/runners/ids.ts`;
  writeFileSync(join(target, ids), replaceOnce(read(ids), "'pi', 'omp'];", "'pi', 'omp', 'sixth'];"));
}

/** The changed paths of `target` outside the four places; empty after `addSixthRunner`. */
export function outsideFourPlaces(target) {
  return git(target, ['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
    .map(line => line.slice(3)).filter(path => !FOUR_PLACES.some(place => path === place || path.startsWith(place)));
}

/** Whether `source`, written in the `src`-relative `file`, imports one of the roster modules. */
function importsRoster(file, source) {
  const specifiers = [...source.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*['"](\.[^'"]+)['"]/g)].map(match => match[1]);
  return specifiers.some(specifier => ROSTER_MODULES.has(posix.join(posix.dirname(file), specifier).replace(/\.(ts|js)$/, '')));
}

/** The roster-reading test files of `target`, repository-relative and sorted. */
export function rosterTests(target) {
  const src = join(target, SRC);
  const files = readdirSync(src, { recursive: true, encoding: 'utf8' }).filter(file => file.endsWith('.test.ts'))
    .filter(file => importsRoster(file, readFileSync(join(src, file), 'utf8'))).map(file => `${SRC}/${file}`);
  return [...new Set([...files, ...GUARD_TESTS, `${SRC}/runners/sixth/harness-sixth-startup-parity.test.ts`])].sort();
}

function main(argv) {
  if (argv.length !== 1) throw new Error('usage: node .ai/scripts/simulate-sixth-runner.mjs <scratch clone>');
  const target = resolve(argv[0]);
  const refused = refusal(target);
  if (refused) throw new Error(refused);
  addSixthRunner(target);
  const outside = outsideFourPlaces(target);
  if (outside.length) throw new Error(`changed outside the four places: ${outside.join(', ')}`);
  process.stdout.write(`${rosterTests(target).join('\n')}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`simulate-sixth-runner: ${error.message}\n`);
    process.exitCode = 1;
  }
}
