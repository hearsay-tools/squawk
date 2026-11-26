import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unitFiles } from './ci-test-selection.mjs';

const changed = { mode: 'changed', base: 'abc', cwd: '/repo', sources: ['packages/web/src/a.ts'], tests: [] };

test('CI resolves the complete unit selection before any shard is applied', () => {
  const calls = [];
  const result = unitFiles({ ...changed, tests: ['packages/cezar/src/lint/scanner.test.ts'] }, (command, args) => {
    calls.push([command, args]);
    return JSON.stringify([{ file: '/repo/packages/web/src/a.test.ts', projectName: 'web' }]);
  });
  assert.deepEqual(result, { files: ['packages/web/src/a.test.ts', 'packages/cezar/src/lint/scanner.test.ts'] });
  assert.ok(calls[0][1].includes('--changed=abc'));
  assert.ok(!calls[0][1].some(arg => arg.startsWith('--shard')));
});

test('declared readers alone need no inventory', () => {
  const result = unitFiles({ ...changed, sources: [], tests: ['packages/cezar/src/lint/scanner-inputs.test.ts'] }, () => assert.fail('must not list tests'));
  assert.deepEqual(result, { files: ['packages/cezar/src/lint/scanner-inputs.test.ts'] });
});

test('an empty, malformed or failed unit inventory names why the full suite runs', () => {
  const reasons = ['[]', '{}', 'broken', '[{}]', '[{"file":"/outside/test.ts"}]'].map(output => unitFiles(changed, () => output).reason);
  assert.equal(reasons[0], 'Vitest selection matched no test file');
  for (const reason of reasons.slice(1, 4)) assert.match(reason, /^Vitest inventory failed: /);
  assert.equal(reasons[4], 'Vitest inventory listed a file outside packages/: ../outside/test.ts');
  const failed = Object.assign(new Error('Command failed'), { stderr: '\nError: no such project "web"\n    at x\n' });
  assert.deepEqual(unitFiles(changed, () => { throw failed; }), { reason: 'Vitest inventory failed: Error: no such project "web"' });
});

test('a full or skip selection keeps its own reason without an inventory', () => {
  for (const mode of ['full', 'skip']) {
    assert.deepEqual(unitFiles({ mode, reason: `${mode} reason` }, () => assert.fail('must not list tests')), { reason: `${mode} reason` });
  }
});
