import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { addCompleteRunner, addSixthRunner, COMPLETE_PLACES, outsideFourPlaces, refusal, rosterTests } from '../.ai/scripts/simulate-sixth-runner.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SRC = 'packages/cezar/src';
// The files the simulation reads, copied from this checkout into a small repository of its own.
const SCRIPTS = 'packages/cezar/scripts';
const INPUTS = [`${SRC}/runners/fixture`, `${SCRIPTS}/mock-fixture-runner.mjs`, `${SRC}/runners/built-in.ts`, `${SRC}/runners/ids.ts`,
  `${SRC}/runners/opencode`, `${SCRIPTS}/mock-skill-data/opencode.mjs`,
  ...readdirSync(join(REPO, SCRIPTS)).filter(file => /^(?:mock-)?opencode-/.test(file)).map(file => `${SCRIPTS}/${file}`)];
const ROSTER_TEST = `${SRC}/core/roster-reader.test.ts`;
const OTHER_TEST = `${SRC}/core/other.test.ts`;

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** A committed scratch repository with the simulation's inputs and two test files; `edit` changes it before the commit. */
function scratch(t, edit = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'simulate-sixth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of INPUTS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO, path), join(root, path), { recursive: true });
  }
  mkdirSync(join(root, SRC, 'core'), { recursive: true });
  writeFileSync(join(root, ROSTER_TEST), "import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';\n");
  writeFileSync(join(root, OTHER_TEST), "import { x } from './ids.ts';\n");
  edit(root);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'inputs');
  return root;
}

test('refuses this repository and its worktrees', () => {
  assert.match(refusal(REPO), /shares this repository's git directory/);
});

test('refuses a checkout with uncommitted changes, and a path that is no checkout', (t) => {
  const root = scratch(t);
  assert.equal(refusal(root), undefined);
  writeFileSync(join(root, 'stray.txt'), 'x\n');
  assert.match(refusal(root), /has uncommitted changes/);
  assert.match(refusal(join(root, 'missing')), /does not exist/);
});

test('adds the sixth runner in the four places only and lists the roster-reading tests', (t) => {
  const root = scratch(t);
  addSixthRunner(root);
  assert.deepEqual(outsideFourPlaces(root), []);
  const runner = join(root, SRC, 'runners/sixth');
  assert.match(readFileSync(join(runner, 'definition.ts'), 'utf8'), /new \(await import\('\.\/sixth-runner\.ts'\)\)\.SixthRunner\(\)/);
  assert.match(readFileSync(join(runner, 'sixth-runner.ts'), 'utf8'), /class SixthRunner implements AgentRunner/);
  assert.match(readFileSync(join(runner, 'facts.ts'), 'utf8'), /^export const SIXTH_FACTS = /m);
  assert.match(readFileSync(join(root, SRC, 'runners/ids.ts'), 'utf8'), /'antigravity', 'sixth'\]/);
  assert.match(readFileSync(join(root, SRC, 'runners/built-in.ts'), 'utf8'), /antigravityRunner, sixthRunner\]/);
  const tests = rosterTests(root);
  assert.ok(tests.includes(ROSTER_TEST));
  assert.ok(tests.includes(`${SRC}/runners/sixth/harness-sixth-startup-parity.test.ts`));
  assert.ok(!tests.includes(OTHER_TEST));
});

test('reports a change outside the four places', (t) => {
  const root = scratch(t);
  addSixthRunner(root);
  writeFileSync(join(root, OTHER_TEST), 'changed\n');
  assert.deepEqual(outsideFourPlaces(root), [OTHER_TEST]);
});

test('turns the fixture\'s mock.testkit.ts, when it has one, into mock.ts', (t) => {
  const fixture = `${SRC}/runners/fixture`;
  const root = scratch(t, (dir) => {
    writeFileSync(join(dir, fixture, 'mock.testkit.ts'), "export const FIXTURE_MOCK_PART = 'fixture';\n");
    writeFileSync(join(dir, fixture, 'definition.testkit.ts'),
      `${readFileSync(join(dir, fixture, 'definition.testkit.ts'), 'utf8')}import { FIXTURE_MOCK_PART } from './mock.testkit.ts';\n`);
  });
  addSixthRunner(root);
  assert.deepEqual(outsideFourPlaces(root), []);
  const runner = join(root, SRC, 'runners/sixth');
  assert.equal(readFileSync(join(runner, 'mock.ts'), 'utf8'), "export const SIXTH_MOCK_PART = 'sixth';\n");
  assert.match(readFileSync(join(runner, 'definition.ts'), 'utf8'), /import \{ SIXTH_MOCK_PART \} from '\.\/mock\.ts';/);
});

/** Every file under `dir`, relative to it. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(file => statSync(join(dir, file)).isFile());
}

test('--complete copies the opencode runner as hexacode in its places only, with every name renamed', (t) => {
  const root = scratch(t);
  const shared = addCompleteRunner(root);
  assert.deepEqual(outsideFourPlaces(root, COMPLETE_PLACES), []);
  const runner = join(root, SRC, 'runners/hexacode');
  assert.deepEqual(filesUnder(runner).sort(), filesUnder(join(root, SRC, 'runners/opencode')).map(file => file.replaceAll('opencode', 'hexacode')).sort());
  const definition = readFileSync(join(runner, 'definition.ts'), 'utf8');
  assert.match(definition, /^export const hexacodeRunner = defineRunner\(\{\n  id: 'hexacode',$/m);
  assert.match(definition, /\(await import\('\.\/hexacode-server-runner\.ts'\)\)\.HexacodeServerRunner\(\)/);
  assert.match(readFileSync(join(runner, 'mock.ts'), 'utf8'), /'mock-hexacode-serve\.mjs'/);
  const mock = join(root, SCRIPTS, 'mock-hexacode-serve.mjs');
  assert.equal(statSync(mock).mode, statSync(join(root, SCRIPTS, 'mock-opencode-serve.mjs')).mode);
  assert.match(readFileSync(mock, 'utf8'), /from '\.\/mock-hexacode-questions\.mjs'/);
  assert.ok(statSync(join(root, SCRIPTS, 'mock-skill-data/hexacode.mjs')).isFile());
  // The shipped task-scope plugin is the runner's own script: copied, and the copy's paths name it.
  assert.match(readFileSync(join(root, SCRIPTS, 'hexacode-task-scope.mjs'), 'utf8'), /^\/\/ HexaCode plugin that Squawk loads/);
  assert.ok(statSync(join(root, SCRIPTS, 'hexacode-task-scope.d.mts')).isFile());
  assert.match(readFileSync(join(runner, 'hexacode-task-scope.ts'), 'utf8'), /'\.\.\/\.\.\/\.\.\/scripts\/hexacode-task-scope\.mjs'/);
  assert.ok(!shared.some(line => line.includes('task-scope')));
  assert.match(readFileSync(join(root, SRC, 'runners/ids.ts'), 'utf8'), /'antigravity', 'hexacode'\]/);
  assert.match(readFileSync(join(root, SRC, 'runners/built-in.ts'), 'utf8'), /import \{ hexacodeRunner \} from '\.\/hexacode\/definition\.ts';\n[^]*antigravityRunner, hexacodeRunner\]/);
  // Only what the copy takes from outside the copied files keeps the old spelling, and each one is reported.
  assert.ok(shared.includes(`${SRC}/runners/opencode/opencode-minimal.ts: opencodeToolGrantFields`));
  assert.match(definition, /\(await import\('\.\/model-settings\.ts'\)\)\.hexacodeModelSettingsStrategy/);
  const keptBy = (path) => shared.filter(line => line.startsWith(`${path}: `)).map(line => line.slice(path.length + 2));
  for (const file of filesUnder(runner)) {
    const kept = keptBy(`${SRC}/runners/opencode/${file.replaceAll('hexacode', 'opencode')}`);
    const rest = kept.reduce((text, word) => text.replaceAll(word, ''), readFileSync(join(runner, file), 'utf8'));
    assert.doesNotMatch(rest, /opencode/i, file);
  }
  const tests = rosterTests(root, 'hexacode');
  assert.ok(tests.includes(ROSTER_TEST));
  assert.ok(tests.includes(`${SRC}/runners/hexacode/harness-hexacode-startup-parity.test.ts`));
  assert.ok(!tests.some(file => file.includes('/runners/opencode/')));
});

test('--complete keeps the paths and imported names a copied file takes from outside the copy', (t) => {
  const folder = `${SRC}/runners/opencode`;
  const root = scratch(t, (dir) => writeFileSync(join(dir, folder, 'extra.ts'), [
    "import { opencodeShared, type OpencodeKind as Kind } from '../../core/shared.ts';",
    "import { OPENCODE_FACTS } from './facts.ts';",
    "export const OpencodePlugin = new URL('../../../scripts/opencode-plugin.mjs', import.meta.url);",
    "export const opencodeOwn = new URL('./opencode-http.ts', import.meta.url);",
    "export const loadOpencode = async () => (await import('../../core/opencode-loader.ts')).loadOpencodeThing;",
    'export const opencodeUse = [opencodeShared, OPENCODE_FACTS];', '',
  ].join('\n')));
  const shared = addCompleteRunner(root);
  assert.deepEqual(shared.filter(line => line.startsWith(`${folder}/extra.ts: `)).map(line => line.split(': ')[1]).sort(),
    ["'../../../scripts/opencode-plugin.mjs'", "'../../core/opencode-loader.ts'", 'OpencodeKind', 'loadOpencodeThing', 'opencodeShared']);
  assert.equal(readFileSync(join(root, SRC, 'runners/hexacode/extra.ts'), 'utf8'), [
    "import { opencodeShared, type OpencodeKind as Kind } from '../../core/shared.ts';",
    "import { HEXACODE_FACTS } from './facts.ts';",
    "export const HexacodePlugin = new URL('../../../scripts/opencode-plugin.mjs', import.meta.url);",
    "export const hexacodeOwn = new URL('./hexacode-http.ts', import.meta.url);",
    "export const loadHexacode = async () => (await import('../../core/opencode-loader.ts')).loadOpencodeThing;",
    'export const hexacodeUse = [opencodeShared, HEXACODE_FACTS];', '',
  ].join('\n'));
});
