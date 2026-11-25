'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');
const ci = () => yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows/ci.yml'), 'utf8'));
function context(event) {
  return { github: { event_name: event, sha: 'queue-sha' },
    needs: { 'pr-test-input': { result: 'success', outputs: { sha: 'immutable-sha' } },
      'queue-proof': { result: 'success', outputs: { verified: 'false' } },
      preflight: { result: 'success' }, 'change-surface': { outputs: { surface: 'full-matrix' } },
      'classify-pr': { outputs: { bump_pr: 'false' } } },
    steps: { 'resolve-dispatch': { outputs: { valid: '' } } }, inputs: {}, cancelled: () => false };
}
function evaluate(raw, ctx) {
  if (raw === undefined) return true;
  return runInNewContext(raw.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/needs\.([\w-]+)/g, "needs['$1']"), ctx);
}
test('queue suites always execute, PR Vitest selects with eight shards, and PR browser shards skip', () => {
  const { jobs } = ci();
  const vitestJob = jobs.vitest, vitestStep = name => vitestJob.steps.find(s => s.id === name);
  assert.deepEqual(vitestJob.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const event of ['merge_group', 'pull_request_target', 'push', 'workflow_dispatch']) {
    const ctx = context(event);
    assert.equal(evaluate(vitestJob.if, ctx), true, `vitest ${event}`);
    assert.equal(evaluate(vitestStep('collect_pr').if, ctx), event === 'pull_request_target');
    assert.equal(evaluate(vitestStep('record').if, ctx), event === 'merge_group');
  }
  const vitest = vitestStep('collect_pr');
  assert.match(vitest.run, /--ci .*--shard=\$\{\{ matrix.shard \}\}\/8/);
  assert.equal(vitest['continue-on-error'], undefined, 'selected failures block the job');
  assert.equal(vitest.env.PR_BASE, '${{ github.event.pull_request.base.sha }}');
  assert.match(vitest.run, /--base="\$PR_BASE".*--coverage.enabled/);

  const browserJob = jobs['cockpit-browser'];
  assert.deepEqual(browserJob.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const event of ['merge_group', 'pull_request_target', 'push', 'workflow_dispatch']) {
    assert.equal(evaluate(browserJob.if, context(event)), event !== 'pull_request_target', `cockpit-browser ${event}`);
  }
  assert.equal(browserJob.steps.find(s => s.id === 'e2e-pr'), undefined, 'no PR browser selection step remains');
  const e2e = browserJob.steps.find(s => s.id === 'e2e');
  assert.equal(e2e.if, undefined);
  assert.match(e2e.run, /npm run test:e2e -- --allow-skip --shard=\$\{\{ matrix.shard \}\}\/8/);
  assert.match(e2e.run, /require-e2e-passed\.cjs < e2e\.log/);
});
test('native PR Vitest keeps immutable input resolution and blocks on a failed resolver', () => {
  const { jobs } = ci();
  const input = jobs['pr-test-input'];
  assert.equal(input.steps[0].with.ref, '${{ github.workflow_sha }}');
  assert.equal(input.steps[0].with['persist-credentials'], false);
  assert.deepEqual(input.permissions, { contents: 'read', 'pull-requests': 'read' });
  for (const event of ['pull_request_target', 'merge_group', 'push', 'workflow_dispatch']) {
    assert.equal(evaluate(input.if, context(event)), event === 'pull_request_target');
  }
  const ctx = context('pull_request_target');
  const checkout = jobs.vitest.steps.find(s => s.uses?.startsWith('actions/checkout@'));
  assert.equal(evaluate(checkout.with.ref, ctx), 'immutable-sha');
  assert.equal(checkout.with['persist-credentials'], false);
  ctx.needs['pr-test-input'].result = 'failure';
  assert.equal(evaluate(jobs.vitest.if, ctx), false);
  for (const id of ['vitest', 'cockpit-browser']) {
    assert.ok(Object.values(jobs[id].permissions).every(value => value === 'read'));
  }
});
