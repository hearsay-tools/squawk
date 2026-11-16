import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unitFiles, browserFiles } from './ci-test-selection.mjs';

test('CI resolves the complete unit selection before any shard is applied', () => {
  const calls = [];
  const result = unitFiles({ mode: 'changed', base: 'abc', cwd: '/repo' }, (command, args) => {
    calls.push([command, args]);
    return JSON.stringify([{ file: '/repo/packages/web/src/a.test.ts', projectName: 'web' }]);
  });
  assert.deepEqual(result, ['packages/web/src/a.test.ts']);
  assert.ok(calls[0][1].includes('--changed=abc'));
  assert.ok(!calls[0][1].some(arg => arg.startsWith('--shard')));
});

test('an empty, malformed or failed unit inventory selects the full suite', () => {
  for (const output of ['[]', '{}', 'broken', '[{}]', '[{"file":"/outside/test.ts"}]']) {
    assert.equal(unitFiles({ mode: 'changed', base: 'abc', cwd: '/repo' }, () => output), null);
  }
  assert.equal(unitFiles({ mode: 'changed', base: 'abc', cwd: '/repo' }, () => { throw new Error('selector error'); }), null);
});

test('shared input, missing base and an unexpected skip select full without an inventory', () => {
  for (const mode of ['full', 'skip']) {
    assert.equal(unitFiles({ mode }, () => assert.fail('must not list tests')), null);
  }
});

test('CI browser selection runs only a shorter list and gives the reason for every other answer', () => {
  assert.deepEqual(browserFiles(() => { throw new Error('missing base\nstack'); }, 2), { skip: 'the selector failed: missing base' });
  const all = { all: true, specs: ['a', 'b'], reason: 'x needs every spec' };
  assert.deepEqual(browserFiles(() => all, 2), { chosen: all, skip: 'the selector chose every spec: x needs every spec' });
  const mappedAll = { all: false, specs: ['a', 'b'] };
  assert.deepEqual(browserFiles(() => mappedAll, 2), { chosen: mappedAll, skip: 'the selector chose every spec' });
  const none = { all: false, specs: [], reason: 'no changed file reaches a browser spec' };
  assert.deepEqual(browserFiles(() => none, 2), { chosen: none, skip: 'the selector chose no spec: no changed file reaches a browser spec' });
  const short = { all: false, specs: ['packages/web/e2e/smoke.e2e.ts'] };
  assert.deepEqual(browserFiles(() => short, 2), { chosen: short });
});
