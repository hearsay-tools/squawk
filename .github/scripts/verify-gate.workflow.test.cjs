'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');
const ci = yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8'));
const heavy = ['build-and-package', 'vitest', 'cockpit-browser'];
function context(event = 'pull_request_target', base = 'main') {
  return { github: { event_name: event, event: { pull_request: { base: { ref: base } } } },
    needs: { preflight: { result: 'success' },
      'queue-proof': { result: 'success', outputs: { verified: 'false' } },
      'pr-test-input': { result: 'success', outputs: { sha: '' } },

      'change-surface': { outputs: { surface: 'full-matrix' } }, 'classify-pr': { outputs: { bump_pr: 'false' } } },
    cancelled: () => false };
}
function evaluate(value, ctx) {
  return runInNewContext(value.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w-]+)/g, "needs['$1']"), ctx);
}
function shell(job, overrides = {}) {
  const env = { PATH: process.env.PATH, BASH_ENV: '/dev/null', CANCELLED: 'false', EVENT_NAME: 'pull_request_target',
    PR_NUMBER: '', PREFLIGHT_RESULT: 'success', QUEUE_ADMISSION_RESULT: 'skipped', CLASSIFY_RESULT: 'success',
    SURFACE_RESULT: 'success', COMPLEXITY_RESULT: 'success', CLONE_RESULT: 'success', COMPLEXITY_GATE_RESULT: 'success',
    CLONE_GATE_RESULT: 'success', TYPECHECK_RESULT: 'success', UNIT_TESTS_RESULT: 'success', BUILD_AND_PACKAGE_RESULT: 'success',
    VITEST_RESULT: 'success', COCKPIT_BROWSER_RESULT: 'success', CHANGE_SURFACE: 'full-matrix', BUMP_PR: 'false',
    PROOF_RESULT: 'success', PROOF_VERIFIED: 'false', ...overrides };
  return spawnSync('bash', ['--noprofile', '--norc', '-eu', '-c', ci.jobs[job].steps[0].run], { env, encoding: 'utf8' });
}
function ancestors(id, chain = []) {
  assert.ok(!chain.includes(id), `CI dependency cycle: ${[...chain, id]}`);
  return [ci.jobs[id].needs ?? []].flat().flatMap(dep => [dep, ...ancestors(dep, [...chain, id])]);
}
test('heavy jobs start without waiting for typecheck or preflight', () => {
  for (const id of Object.keys(ci.jobs)) ancestors(id);
  for (const id of heavy) {
    for (const gate of ['typecheck', 'preflight']) {
      assert.ok(!ancestors(id).includes(gate), `${id} must not wait for ${gate}`);
      assert.doesNotMatch(ci.jobs[id].if, new RegExp(gate), `${id} must not read ${gate}`);
    }
    assert.match(ci.jobs[id].if, /!cancelled\(\)/, 'intentional skips cannot invoke implicit success()');
  }
  for (const gate of ['preflight', 'typecheck', ...heavy]) {
    assert.ok(ci.jobs.verify.needs.includes(gate), `verify must still require ${gate}`);
  }
});
test('passing cheap gates never excuse missing, blocked or failed tests', () => {
  for (const id of ['build-and-package', 'vitest']) assert.equal(evaluate(ci.jobs[id].if, context()), true, id);
  assert.equal(evaluate(ci.jobs['cockpit-browser'].if, context()), false, 'PR skips browser shards');
  for (const key of ['UNIT_TESTS_RESULT', 'BUILD_AND_PACKAGE_RESULT', 'VITEST_RESULT']) {
    for (const result of ['failure', 'skipped', 'cancelled', '']) assert.notEqual(shell('verify', { [key]: result }).status, 0);
  }
  for (const result of ['failure', 'cancelled', '']) assert.notEqual(shell('verify', { COCKPIT_BROWSER_RESULT: result }).status, 0);
  assert.equal(shell('verify', { COCKPIT_BROWSER_RESULT: 'skipped' }).status, 0);
  assert.notEqual(shell('verify', { EVENT_NAME: 'merge_group', QUEUE_ADMISSION_RESULT: 'success', COCKPIT_BROWSER_RESULT: 'skipped' }).status, 0);
  assert.equal(shell('verify').status, 0);
});
// Queue admission runs only for a merge group. There it gates the required
// aggregate; on every other event its skip is not read.
test('verify requires queue admission for a merge group and for no other event', () => {
  assert.ok(ci.jobs.verify.needs.includes('queue-admission'));
  assert.ok(!ancestors('queue-admission').includes('verify'), 'admission runs before the aggregate');
  for (const id of [...heavy, 'typecheck', 'preflight', 'unit-tests']) {
    assert.ok(ancestors('queue-admission').includes(id), `admission reads evidence after ${id}`);
    assert.ok(!ancestors(id).includes('queue-admission'), `${id} must not wait for admission`);
  }
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    assert.notEqual(shell('verify', { EVENT_NAME: 'merge_group', QUEUE_ADMISSION_RESULT: result }).status, 0, result);
  }
  assert.equal(shell('verify', { EVENT_NAME: 'merge_group', QUEUE_ADMISSION_RESULT: 'success' }).status, 0);
  for (const event of ['pull_request_target', 'push', 'workflow_dispatch']) {
    assert.equal(shell('verify', { EVENT_NAME: event, QUEUE_ADMISSION_RESULT: 'skipped' }).status, 0, event);
  }
});
test('queue admission starts only for a merge group whose verification jobs did not fail', () => {
  const admission = ci.jobs['queue-admission'].if;
  const run = (event, { cancelled = false, failed = false } = {}) => evaluate(admission,
    { ...context(event), cancelled: () => cancelled, failure: () => failed });
  assert.equal(run('merge_group'), true);
  assert.equal(run('merge_group', { failed: true }), false);
  assert.equal(run('merge_group', { cancelled: true }), false);
  for (const event of ['pull_request_target', 'push', 'workflow_dispatch']) assert.equal(run(event), false, event);
});
test('only existing trusted docs/infra/bump exemptions skip shards, never build/package', () => {
  for (const surface of ['docs-only', 'infra-only']) {
    const ctx = context(); ctx.needs['change-surface'].outputs.surface = surface;
    assert.equal(evaluate(ci.jobs['build-and-package'].if, ctx), true);
    for (const id of heavy.slice(1)) assert.equal(evaluate(ci.jobs[id].if, ctx), false);
    assert.equal(shell('verify', { CHANGE_SURFACE: surface, VITEST_RESULT: 'skipped', COCKPIT_BROWSER_RESULT: 'skipped' }).status, 0);
  }
  const ctx = context(); ctx.needs['classify-pr'].outputs.bump_pr = 'true';
  for (const id of heavy.slice(1)) assert.equal(evaluate(ci.jobs[id].if, ctx), false);
});
test('cancellation cannot release work or green required gates', () => {
  const ctx = context(); ctx.cancelled = () => true;
  for (const id of heavy) assert.equal(evaluate(ci.jobs[id].if, ctx), false);
  for (const id of ['preflight', 'verify']) assert.notEqual(shell(id, { CANCELLED: 'true' }).status, 0);
});

for (const event of ['pull_request_target', 'merge_group', 'workflow_dispatch', 'push']) {
  for (const result of ['failure', 'cancelled', 'skipped', '', 'pending']) {
    test(`${event}: typecheck/preflight ${result} lets heavy jobs start but fails the aggregate`, () => {
      const ctx = context(event);
      ctx.needs.typecheck = { result };
      ctx.needs.preflight.result = result;
      for (const id of heavy) assert.equal(evaluate(ci.jobs[id].if, ctx), !(event === 'pull_request_target' && id === 'cockpit-browser'), id);
      for (const key of ['TYPECHECK_RESULT', 'PREFLIGHT_RESULT']) {
        assert.notEqual(shell('verify', { EVENT_NAME: event, [key]: result }).status, 0, key);
      }
    });
  }
}
test('heavy PR jobs require immutable test inputs, while non-PR jobs tolerate the skipped resolver', () => {
  for (const result of ['failure', 'cancelled', 'skipped', '']) {
    const ctx = context(); ctx.needs['pr-test-input'].result = result;
    for (const id of ['build-and-package', 'vitest']) assert.equal(evaluate(ci.jobs[id].if, ctx), false, id);
    assert.equal(evaluate(ci.jobs['cockpit-browser'].if, ctx), false, 'cockpit-browser skips PRs');
  }
  for (const event of ['merge_group', 'workflow_dispatch', 'push']) {
    const ctx = context(event); ctx.needs['pr-test-input'].result = 'skipped';
    for (const id of heavy) assert.equal(evaluate(ci.jobs[id].if, ctx), true, id);
  }
});

test('preflight requires all applicable cheap gates and permits only exact queue proof typecheck reuse', () => {
  assert.equal(shell('preflight').status, 0);
  for (const key of ['CLASSIFY_RESULT', 'SURFACE_RESULT', 'COMPLEXITY_RESULT', 'CLONE_RESULT', 'TYPECHECK_RESULT']) {
    for (const result of ['failure', 'skipped', 'cancelled', '']) assert.notEqual(shell('preflight', { [key]: result }).status, 0);
  }
  assert.equal(shell('preflight', { EVENT_NAME: 'push', PROOF_VERIFIED: 'true', TYPECHECK_RESULT: 'skipped' }).status, 0);
  assert.notEqual(shell('preflight', { PROOF_VERIFIED: 'true', TYPECHECK_RESULT: 'skipped' }).status, 0);
});
test('always aggregates reject cancellation even if all retained prerequisites succeeded', () => {
  for (const job of [ci.jobs.preflight, ci.jobs.verify]) {
    const guard = job.steps.find(step => step.name === 'Reject a cancelled run');
    assert.ok(guard);
    assert.equal(evaluate(guard.if, { cancelled: () => true }), true);
    assert.notEqual(spawnSync('bash', ['-c', guard.run]).status, 0);
  }
});
