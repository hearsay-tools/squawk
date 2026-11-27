'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');
const { CI_WORKFLOW, LABEL_GATES } = require('./rerun-label-gates.cjs');

const workflowsDir = path.join(__dirname, '..', 'workflows');
const readYaml = name => yaml.parse(fs.readFileSync(path.join(workflowsDir, name), 'utf8'));

test('rerun-label-gates workflow runs trusted base code on labeled events with per-PR lock and minimal write scope', () => {
  const wf = readYaml('rerun-label-gates.yml');
  assert.deepEqual(Object.keys(wf.on), ['pull_request_target']);
  assert.deepEqual(wf.on.pull_request_target.types, ['labeled']);
  assert.deepEqual(wf.on.pull_request_target.branches, ['main', 'release/**']);
  assert.deepEqual(wf.permissions, {});

  const job = wf.jobs.rerun;
  assert.deepEqual(job.permissions, { actions: 'write', contents: 'read', 'pull-requests': 'read' });
  assert.equal(job.concurrency.group, 'rerun-label-gates-pr-${{ github.event.pull_request.number }}');
  assert.equal(job.concurrency['cancel-in-progress'], false);
  assert.equal(job['timeout-minutes'], 25);

  const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with.ref, '${{ github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(checkout.with['fetch-depth'], 1);
  assert.equal(checkout.with['sparse-checkout'], '.github/scripts');
  assert.doesNotMatch(JSON.stringify(job), /pull_request\.head|refs\/pull\/|allow-unsafe-pr-checkout/);

  const runs = (state, label) => runInNewContext(job.if, {
    github: { event: { pull_request: { state }, label: { name: label } } },
  });
  for (const label of Object.keys(LABEL_GATES)) {
    assert.equal(runs('open', label), true, label);
    assert.equal(runs('closed', label), false, label);
  }
  assert.equal(runs('open', 'auto-merge'), false);
  assert.equal(runs('open', 'mutants'), false);
});

test('every job and step in LABEL_GATES matches ci.yml and sits outside Vitest dependencies', () => {
  const ci = readYaml(CI_WORKFLOW);
  const byName = new Map(Object.entries(ci.jobs).map(([id, job]) => [job.name, { id, job }]));
  for (const [label, gates] of Object.entries(LABEL_GATES)) {
    assert.ok(gates.length > 0, label);
    for (const gate of gates) {
      const entry = byName.get(gate.job);
      assert.ok(entry, `${label}: ci.yml must define job "${gate.job}"`);
      assert.ok(entry.job.steps.some(step => step.name === gate.step), `${label}: "${gate.job}" must define step "${gate.step}"`);
      assert.equal(ci.jobs.vitest.needs.includes(entry.id), false, `${entry.id} must not be a dependency of vitest`);
      assert.equal(ci.jobs['cockpit-browser'].needs.includes(entry.id), false, `${entry.id} must not be a dependency of cockpit-browser`);
      assert.ok(ci.jobs.preflight.needs.includes(entry.id), `${entry.id} must feed preflight`);
      assert.ok(ci.jobs.verify.needs.includes(entry.id), `${entry.id} must feed verify`);
    }
  }
});
