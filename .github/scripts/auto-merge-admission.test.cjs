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
  ['VISION.md', 'agent instructions or contracts'],
  ['CONVENTIONS.md', 'agent instructions or contracts'],
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

for (const relative of [
  'packages/cezar/src/lint/server-wait-loops.ts',
  'packages/cezar/src/lint/unit-wait-values.ts',
  'packages/cezar/src/lint/wait-babel-tree.ts',
  'packages/cezar/src/lint/wait-oxlint.ts',
  'packages/cezar/src/lint/wait-source.ts',
]) test(`the wait rule engine ${relative} takes added cases and keeps owner review for any other change`, t => {
  const changed = checkChange(t, relative, 'first: 1\nsecond: 2\n', 'first: 1\nsecond: 3\n');
  assert.equal(changed.status, 1, changed.stdout + changed.stderr);
  assert.ok(changed.stdout.includes(`guard test change: ${relative}`), changed.stdout);
  const added = checkChange(t, relative, 'first: 1\n', 'first: 1\nsecond: 2\n');
  assert.equal(added.status, 0, added.stdout + added.stderr);
});

const pins = (comment, files) => `${JSON.stringify({ $comment: comment, limit: 1000, files }, null, 2)}\n`;
const sites = (entries) => `${JSON.stringify({ entries }, null, 2)}\n`;

for (const [label, relative, before, after] of [
  ['lowering one pin and dropping another', 'packages/cezar/src/file-length.baseline.json',
    pins('Pins.', { 'a.ts': 1200, 'b.ts': 1100 }), pins('Pins.', { 'a.ts': 1150 })],
  ['dropping a site', 'packages/cezar/src/lint/home-readers.baseline.json',
    sites([{ file: 'a.ts', calls: 2 }, { file: 'b.ts', calls: 1 }]), sites([{ file: 'a.ts', calls: 1 }])],
  ['emptying a wait baseline', 'packages/web/src/test/unit-wait-discipline.baseline.json',
    '{ "$comment": "Shrinks.", "sites": ["x"] }\n', '{ "$comment": "Shrinks.", "sites": [] }\n'],
]) test(`a ratchet baseline change ${label} qualifies`, t => {
  const result = checkChange(t, relative, before, after);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

for (const [label, before, after] of [
  ['raising a pin', pins('Pins.', { 'a.ts': 1200 }), pins('Pins.', { 'a.ts': 1201 })],
  ['adding a pin', pins('Pins.', { 'a.ts': 1200 }), pins('Pins.', { 'a.ts': 1200, 'b.ts': 1001 })],
  ['lowering a pin and changing the comment', pins('Pins.', { 'a.ts': 1200 }), pins('Pins may grow.', { 'a.ts': 1100 })],
  ['dropping the limit', pins('Pins.', { 'a.ts': 1200 }), '{ "$comment": "Pins.", "files": { "a.ts": 1200 } }\n'],
  ['dropping a field from a site', '{ "$comment": "Pins.", "sites": [{ "file": "a.ts", "count": 2 }] }\n',
    '{ "$comment": "Pins.", "sites": [{ "file": "a.ts" }] }\n'],
]) test(`a ratchet baseline change ${label} requires owner review`, t => {
  const relative = 'packages/cezar/src/file-length.baseline.json';
  const result = checkChange(t, relative, before, after);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`lint gate: ${relative}`), result.stdout);
});

test('path rules name each guarded file, file mode change and new baseline', async () => {
  const { pathReasons } = await import(require('node:url').pathToFileURL(script).href);
  const file = (relative, change = {}) => ({ path: relative, status: 'M', oldMode: '100644', newMode: '100644', adds: ['new'], dels: ['old'], ...change });
  assert.deepEqual(pathReasons({ files: [
    file('.oxlintrc.json'),
    file('packages/cezar/src/lint/run.test.ts', { dels: [] }),
    file('packages/cezar/src/lint/new-rule.baseline.json', { status: 'A', dels: [] }),
    file('packages/cezar/src/file-length.baseline.json', { adds: [], lowers: true }),
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

for (const [label, before, after] of [
  ['adding an HSQ_* entry', '# existing\n', '# existing\n# HSQ_SECRET_BYPASS=1\n'],
  ['editing an HSQ_* entry', '# HSQ_SECRET_BYPASS=1\n', '# HSQ_SECRET_BYPASS=0\n'],
  ['removing an HSQ_* entry', '# HSQ_SECRET_BYPASS=1\n', '# existing\n'],
  ['adding an HSQ_MOCK_* entry', '# existing\n', '# existing\n# HSQ_MOCK_CONTROL=1\n'],
  ['adding a CEZ_* entry', '# existing\n', '# existing\n# CEZ_SECRET_BYPASS=1\n'],
]) test(`${label} in .env.example requires owner review`, t => {
  const result = checkChange(t, '.env.example', before, after);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes('DOES NOT QUALIFY'), result.stdout);
  assert.ok(result.stdout.includes('changes an HSQ_* or CEZ_* entry in .env.example'), result.stdout);
});

for (const [label, before, after, variable] of [
  ['adding an HSQ_* variable', 'export const flag = false;\n', 'export const flag = Boolean(process.env.HSQ_SECRET_BYPASS);\n', 'HSQ_SECRET_BYPASS'],
  ['creating a file with an HSQ_* variable', null, 'export const flag = Boolean(process.env.HSQ_SECRET_BYPASS);\n', 'HSQ_SECRET_BYPASS'],
  ['removing an HSQ_* variable', 'export const flag = Boolean(process.env.HSQ_SECRET_BYPASS);\n', 'export const flag = false;\n', 'HSQ_SECRET_BYPASS'],
  ['adding an HSQ_MOCK_* variable', 'export const flag = false;\n', 'export const flag = Boolean(process.env.HSQ_MOCK_CONTROL);\n', 'HSQ_MOCK_CONTROL'],
  ['adding a CEZ_* variable', 'export const flag = false;\n', 'export const flag = Boolean(process.env.CEZ_SECRET_BYPASS);\n', 'CEZ_SECRET_BYPASS'],
]) test(`${label} in production source requires owner review`, t => {
  const result = checkChange(t, 'packages/cezar/src/sample.ts', before, after);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.includes('DOES NOT QUALIFY'), result.stdout);
  assert.ok(result.stdout.includes(`adds or removes an HSQ_* or CEZ_* variable: ${variable}`), result.stdout);
});

test('editing an existing HSQ_* reference or a CEZ_MOCK_* variable still qualifies', t => {
  const editedExisting = checkChange(
    t,
    'packages/cezar/src/sample.ts',
    "export const flag = process.env.HSQ_EXISTING === '1';\n",
    "export const flag = process.env.HSQ_EXISTING === '0';\n",
  );
  assert.equal(editedExisting.status, 0, editedExisting.stdout + editedExisting.stderr);
  assert.ok(editedExisting.stdout.includes('QUALIFIES'), editedExisting.stdout);

  const mockEnvExample = checkChange(t, '.env.example', '# existing\n', '# existing\n# CEZ_MOCK_CONTROL=1\n');
  assert.equal(mockEnvExample.status, 0, mockEnvExample.stdout + mockEnvExample.stderr);

  const mockSource = checkChange(t, 'packages/cezar/src/sample.ts', 'export const flag = false;\n', 'export const flag = Boolean(process.env.CEZ_MOCK_CONTROL);\n');
  assert.equal(mockSource.status, 0, mockSource.stdout + mockSource.stderr);
});
