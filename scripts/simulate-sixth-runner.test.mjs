import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { addSixthRunner, outsideFourPlaces, refusal, rosterTests } from '../.ai/scripts/simulate-sixth-runner.mjs';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SRC = 'packages/cezar/src';
// The files the simulation reads, copied from this checkout into a small repository of its own.
const INPUTS = [`${SRC}/runners/fixture`, 'packages/cezar/scripts/mock-fixture-runner.mjs', `${SRC}/runners/built-in.ts`, `${SRC}/runners/ids.ts`];
const ROSTER_TEST = `${SRC}/core/roster-reader.test.ts`;
const OTHER_TEST = `${SRC}/core/other.test.ts`;

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** A committed scratch repository with the simulation's inputs and two test files. */
function scratch(t) {
  const root = mkdtempSync(join(tmpdir(), 'simulate-sixth-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of INPUTS) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(REPO, path), join(root, path), { recursive: true });
  }
  mkdirSync(join(root, SRC, 'core'), { recursive: true });
  writeFileSync(join(root, ROSTER_TEST), "import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';\n");
  writeFileSync(join(root, OTHER_TEST), "import { x } from './ids.ts';\n");
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
  assert.match(readFileSync(join(root, SRC, 'runners/ids.ts'), 'utf8'), /'omp', 'sixth'\]/);
  assert.match(readFileSync(join(root, SRC, 'runners/built-in.ts'), 'utf8'), /ompRunner, sixthRunner\]/);
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
