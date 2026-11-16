import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NO_VITEST_READER, VITEST_TEST, classify, configurationClosure, existingTests, readInputs } from './test-inputs.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function fixture(t, files) {
  const cwd = mkdtempSync(join(tmpdir(), 'test-inputs-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  return cwd;
}

const scanner = 'packages/cezar/src/lint/scanner.test.ts';
const astGrep = 'packages/cezar/src/ast-grep-rules.test.ts';
const repo = t => fixture(t, {
  'squeal.config.json': JSON.stringify({ inputs: {
    [astGrep]: ['.ai/ast-grep/**'],
    [scanner]: ['packages/**/*.ts', 'packages/*/src/**/*.json', 'packages/cezar/src/lint/rule.baseline.json'],
    'packages/cezar/src/protocol.test.ts': ['AGENT_PROTOCOL.md'],
    '.github/scripts/*.test.cjs': ['.github/scripts/**'],
    'packages/cezar/test/unit/launcher.test.ts': ['.ai/scripts/test-env-up.sh'],
  } }),
  'vitest.config.ts': "import Sequencer from './.github/scripts/ci-test-sequencer.mjs'\n",
  '.github/scripts/ci-test-sequencer.mjs': "export { a } from '../../scripts/helper.mjs'\n",
  'scripts/helper.mjs': '',
  'packages/cezar/vitest.setup.ts': "import { guard } from './src/guard.testkit.ts'\n",
  'packages/cezar/src/guard.testkit.ts': "import { home } from './home.js'\n",
  'packages/cezar/src/home.ts': '',
});

test('the configuration closure follows static imports from the Vitest configuration and setup files', t => {
  assert.deepEqual([...configurationClosure(repo(t))].sort(), [
    '.github/scripts/ci-test-sequencer.mjs', 'packages/cezar/src/guard.testkit.ts', 'packages/cezar/src/home.ts',
    'packages/cezar/vitest.setup.ts', 'scripts/helper.mjs', 'vitest.config.ts',
  ]);
});

test('an ast-grep rule selects its declared readers, not the full suite', t => {
  assert.deepEqual(classify(['.ai/ast-grep/rules/no-x.yml'], repo(t)), { sources: [], tests: [astGrep] });
});

test('source selects the import graph plus every scanner that reads it, deleted source included', t => {
  // packages/cezar/src/gone.ts does not exist: a deletion is classified like any other path.
  assert.deepEqual(classify(['packages/cezar/src/gone.ts', 'packages/cezar/src/home.ts'], repo(t)),
    { sources: ['packages/cezar/src/gone.ts', 'packages/cezar/src/home.ts'], tests: [scanner] });
});

test('a snapshot selects its test and a lint baseline selects its declared readers', t => {
  const cwd = repo(t);
  assert.deepEqual(classify(['packages/web/src/__snapshots__/view.test.tsx.snap'], cwd), { sources: [], tests: ['packages/web/src/view.test.tsx'] });
  assert.deepEqual(classify(['packages/cezar/src/lint/rule.baseline.json'], cwd), { sources: [], tests: [scanner] });
  // A wildcard declaration neither names a baseline's reader nor joins an exact one.
  const wide = fixture(t, { 'squeal.config.json': JSON.stringify({ inputs: {
    [scanner]: ['packages/*/src/**/*.json'], 'packages/web/src/test/wait.test.ts': ['packages/web/src/test/wait.baseline.json'],
  } }) });
  assert.deepEqual(classify(['packages/web/src/test/wait.baseline.json'], wide), { sources: [], tests: ['packages/web/src/test/wait.test.ts'] });
  assert.deepEqual(classify(['packages/web/src/test/other.baseline.json'], cwd),
    { full: 'Package input outside the import graph: packages/web/src/test/other.baseline.json' });
});

test('inputs no Vitest test reads select nothing', t => {
  const cwd = repo(t);
  for (const path of ['.github/mutants/run.json', '.github/workflows/ci.yml', '.github/scripts/apply.cjs', '.ai/skills/x/SKILL.md', 'scripts/a.test.mjs']) {
    assert.deepEqual(classify([path], cwd), { sources: [], tests: [] }, path);
  }
});

test('each full-suite rule names its reason and the first path', t => {
  const cwd = repo(t);
  const cases = {
    'package.json': 'Vitest configuration input: package.json',
    'pnpm-lock.yaml': 'Vitest configuration input: pnpm-lock.yaml',
    '.github/scripts/ci-test-sequencer.mjs': 'Vitest configuration input: .github/scripts/ci-test-sequencer.mjs',
    'scripts/helper.mjs': 'Vitest configuration input: scripts/helper.mjs',
    'packages/contract/src/runs.ts': 'Package input outside the import graph: packages/contract/src/runs.ts',
    'packages/cezar/src/fixtures/data.json': 'Package input outside the import graph: packages/cezar/src/fixtures/data.json',
    '.ai/scripts/test-env-up.sh': 'Unmapped input: .ai/scripts/test-env-up.sh',
    'packages/web/src/ü.ts': 'Unusual path: packages/web/src/ü.ts',
  };
  for (const [path, reason] of Object.entries(cases)) assert.deepEqual(classify([path], cwd), { full: reason }, path);
  assert.deepEqual(classify(['.ai/ast-grep/a.yml', 'tools/a.sh', 'tools/b.sh'], cwd), { full: 'Unmapped input: tools/a.sh (+1 more)' });
});

test('a missing squeal.config.json declares no reader', t => {
  const cwd = fixture(t, { 'vitest.config.ts': '' });
  assert.deepEqual(readInputs(cwd), []);
  assert.deepEqual(classify(['AGENT_PROTOCOL.md'], cwd), { full: 'Unmapped input: AGENT_PROTOCOL.md' });
});

test('a declared test that no longer exists selects nothing', t => {
  const cwd = fixture(t, { 'packages/web/src/a.test.ts': '' });
  assert.deepEqual(existingTests(cwd, ['packages/web/src/a.test.ts', 'packages/web/src/gone.test.ts']), ['packages/web/src/a.test.ts']);
});

test('VITEST_TEST matches the include pattern of every unit project', () => {
  for (const name of ['api-client', 'cezar', 'contract', 'web']) {
    const config = readFileSync(join(repoRoot, 'packages', name, 'vitest.config.ts'), 'utf8');
    const include = /include:\s*\[([^\]]+)\]/.exec(config)?.[1];
    assert.ok(include, name);
    for (const [, pattern] of include.matchAll(/'([^']+)'/g)) {
      const example = `packages/${name}/${pattern.replace('**/', 'a/').replace('*', 'x').replace('{ts,tsx}', 'tsx')}`;
      assert.ok(matchesGlob(example, VITEST_TEST), example);
    }
  }
});

// Tripwire for NO_VITEST_READER. A Vitest file that reads a path on that list
// near a read call must declare it in squeal.config.json `inputs`, or PR
// selection skips the test when the path changes. A text scan, like
// .github/scripts/change-surface-readers.test.cjs: it misses paths built from
// separate segments, and the merge queue's full run still catches those.
const TOKEN = /['"`]((?:\.\.\/)*(?:\.github|\.ai|scripts)(?:\/[\w.@*-]+)*)['"`/]/g;
const READ_CALL = /\b(?:readFile|readFileSync|readdirSync|existsSync|createReadStream|require|import)\s*\(|new URL\(/;
const READ_WINDOW_LINES = 5;

function undeclaredReaders(root) {
  const inputs = readInputs(root).filter(({ test }) => matchesGlob(test, VITEST_TEST));
  // A test file must declare what it reads itself; a helper's read may be declared by any test.
  const declares = (file, path) => inputs.some(({ test, globs }) =>
    (!matchesGlob(file, VITEST_TEST) || matchesGlob(file, test)) && globs.some(glob => matchesGlob(path, glob)));
  const files = execFileSync('git', ['ls-files', '-z', '--others', '--cached', '--exclude-standard', '--', 'packages/*/src/*.ts', 'packages/*/src/*.tsx', 'packages/*/vitest.setup.ts'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const undeclared = [];
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return;
      for (const [, raw] of line.matchAll(TOKEN)) {
        const path = raw.replace(/^(?:\.\.\/)+/, '');
        if (!NO_VITEST_READER.some(glob => matchesGlob(path, glob) || matchesGlob(`${path}/x`, glob))) continue;
        if (!lines.slice(Math.max(0, index - READ_WINDOW_LINES), index + READ_WINDOW_LINES + 1).some(near => READ_CALL.test(near))) continue;
        if (!declares(file, path)) undeclared.push(`${file}:${index + 1} reads ${path}`);
      }
    });
  }
  return undeclared;
}

test('every Vitest reader of a path no Vitest test reads is declared', () => {
  assert.deepEqual(undeclaredReaders(repoRoot), [], 'declare each reader in squeal.config.json inputs');
});

test('the tripwire checks each reading test file against its own declaration', t => {
  const read = "const x = readFileSync('../../.github/scripts/growth.cjs')\n";
  const root = fixture(t, {
    'squeal.config.json': JSON.stringify({ inputs: { 'packages/cezar/src/first.test.ts': ['.github/scripts/growth.cjs'] } }),
    'packages/cezar/src/first.test.ts': read,
    'packages/cezar/src/second.test.ts': read,
    'packages/cezar/src/helper.testkit.ts': read,
  });
  execFileSync('git', ['init', '-q'], { cwd: root });
  assert.deepEqual(undeclaredReaders(root), ['packages/cezar/src/second.test.ts:1 reads .github/scripts/growth.cjs']);
});

test('the tripwire finds the declared reader of .github/scripts/baseline-growth.cjs', () => {
  const source = readFileSync(join(repoRoot, 'packages/cezar/src/lint/home-boundary.test.ts'), 'utf8');
  assert.ok([...source.matchAll(TOKEN)].some(([, raw]) => raw.endsWith('.github/scripts/baseline-growth.cjs')));
});
