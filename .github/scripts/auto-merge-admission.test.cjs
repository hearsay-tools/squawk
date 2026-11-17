'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const script = path.resolve(__dirname, '../../.ai/skills/auto-merge/check.mjs');

// Commits `before`, then `after`, to `relative` in a fresh repository and runs check.mjs on the change.
function checkChange(t, relative, before, after) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-admission-policy-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = (content, message) => {
    const file = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content);
    git('add', '-A');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message, '--allow-empty');
  };
  git('init', '-q');
  commit(before, 'base');
  const base = git('rev-parse', 'HEAD');
  commit(after, 'change');
  return spawnSync(process.execPath, [script, '--title', 'fix: adjust a gate', '--base', base], { cwd, encoding: 'utf8' });
}

for (const name of [
  'merge-queue-admission', 'queue-ci-proof', 'pr-test-proof', 'pr-test-input',
  'pr-readiness', 'review-threads', 'review-signal', 'release-bump-pr',
  'check-clones', 'check-spec-status', 'check-citations', 'change-coupling', 'api-budget',
  'missing-patches', 'failure-diagnostics', 'vitest-worker-count',
]) test(`a small ${name} change requires owner review`, t => {
  const relative = `.github/scripts/${name}.cjs`;
  const result = checkChange(t, relative, 'module.exports = false;\n', 'module.exports = true;\n');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`gate or test harness: ${relative}`), result.stdout);
});

for (const [relative, why] of [
  ['.github/scripts/merge-vitest-coverage.mjs', 'gate or test harness'],
  ['.github/scripts/vitest-coverage-tests.mjs', 'gate or test harness'],
  ['.github/scripts/vitest-file-duration.mjs', 'gate or test harness'],
  ['.github/scripts/auto-merge-gates.test.cjs', 'gate or test harness'],
  ['.github/scripts/auto-merge-admission.test.cjs', 'gate or test harness'],
  ['.github/actions/node-dist/action.yml', 'gate or test harness'],
  ['scripts/prepr.mjs', 'gate or test harness'],
  ['scripts/check-typecheck-coverage.mjs', 'gate or test harness'],
  ['scripts/test-home-env.mjs', 'gate or test harness'],
  ['scripts/test-package.mjs', 'gate or test harness'],
  ['packages/cezar/src/lint/run.ts', 'lint gate'],
  ['packages/cezar/src/lint/home-readers.baseline.json', 'lint gate'],
  ['packages/cezar/src/file-length.baseline.json', 'lint gate'],
  ['packages/web/src/test/unit-wait-discipline.baseline.json', 'lint gate'],
  ['packages/web/e2e/fetch-setup.mjs', 'gate or test harness'],
  ['packages/web/e2e/wait-support.ts', 'gate or test harness'],
  ['packages/cezar/src/test-outbound-guard.testkit.ts', 'gate or test harness'],
  ['packages/web/src/test/wait-baseline.ts', 'guard test change'],
  ['scripts/test-browser-home-env.mjs', 'gate or test harness'],
  ['packages/web/product-identity.ts', 'build or release source'],
  ['.oxlintrc.json', 'lint gate'],
  ['packages/cezar/src/lint/plugin.test.ts', 'guard test change'],
]) test(`changing ${relative} requires owner review`, t => {
  const [before, after] = relative.endsWith('.json') ? ['{ "first": 1 }\n', '{ "first": 2 }\n'] : ['first: 1\nsecond: 2\n', 'first: 1\nsecond: 3\n'];
  const result = checkChange(t, relative, before, after);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`${why}: ${relative}`), result.stdout);
});

for (const relative of [
  'packages/web/e2e/new-flow.e2e.ts',
  'packages/cezar/src/lint/plugin.test.ts',
]) test(`adding cases to ${relative} qualifies`, t => {
  const added = checkChange(t, relative, 'first: 1\n', 'first: 1\nsecond: 2\n');
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const created = checkChange(t, relative, null, 'first: 1\n');
  assert.equal(created.status, 0, created.stdout + created.stderr);
});

test('path rules name each guarded file, file mode change and new baseline', async () => {
  const { pathReasons } = await import(require('node:url').pathToFileURL(script).href);
  const file = (relative, change = {}) => ({ path: relative, status: 'M', oldMode: '100644', newMode: '100644', adds: ['new'], dels: ['old'], ...change });
  assert.deepEqual(pathReasons({ files: [
    file('.oxlintrc.json'),
    file('packages/cezar/src/lint/run.test.ts', { dels: [] }),
    file('packages/cezar/src/lint/new-rule.baseline.json', { status: 'A', dels: [] }),
    file('docs/run.sh', { newMode: '100755' }),
    file('docs/link', { newMode: '120000' }),
    file('README.md'),
  ] }), [
    'lint gate: .oxlintrc.json',
    'new ratchet baseline: packages/cezar/src/lint/new-rule.baseline.json',
    'lint gate: packages/cezar/src/lint/new-rule.baseline.json',
    'changes the file mode: docs/run.sh',
    'symlink or submodule: docs/link',
  ]);
});
