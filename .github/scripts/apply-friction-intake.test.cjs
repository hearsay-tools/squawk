const test = require('node:test');
const assert = require('node:assert/strict');
const { applyClassification, ensureLabel } = require('./apply-friction-intake.cjs');
const { LABELS } = require('./friction-policy.cjs');

function harness(overrides = {}) {
  const issue = { number: 12, title: 'Show events', body: 'Print evidence.', state: 'open', labels: [{ name: 'friction' }, { name: 'area-cezar' }], ...overrides };
  const input = { issue: { number: 12, title: 'Show events', body: 'Print evidence.', managedLabels: issue.labels.map(l => l.name).filter(name => name.startsWith('friction-')) }, classification: { category: 'diagnostics', handling: 'automatic', probabilities: { category: 0.95, established: 0.95, policy_change: 0.01, authority_change: 0.01, verification_change: 0.01, runtime_change: 0.01 } } };
  const mutations = [];
  const github = { rest: { issues: {
    get: async () => ({ data: structuredClone(issue) }),
    getLabel: async x => ({ data: { ...LABELS.find(l => l.name === x.name) } }),
    createLabel: async x => { mutations.push(['create', x.name]); },
    updateLabel: async x => { mutations.push(['update', x.name]); },
    removeLabel: async x => { mutations.push(['remove', x.name]); issue.labels = issue.labels.filter(l => l.name !== x.name); },
    addLabels: async x => { mutations.push(['add', x.labels]); for (const name of x.labels) if (!issue.labels.some(l => l.name === name)) issue.labels.push({ name }); },
  } } };
  const run = (data = input) => applyClassification({ github, repo: { owner: 'hearsay-tools', repo: 'cezarion' }, issueNumber: 12, input: data });
  return { issue, input, mutations, github, run };
}

test('adds one category and handling pair without replacing unrelated labels', async () => {
  const h = harness();
  await h.run();
  assert.deepEqual(h.issue.labels.map(l => l.name), ['friction', 'area-cezar', 'friction-diagnostics', 'friction-auto']);
  assert.deepEqual(h.mutations, [['add', ['friction-diagnostics', 'friction-auto']]]);
});

test('reclassification removes old routes before adding the new pair and is idempotent', async () => {
  const h = harness({ labels: [{ name: 'friction' }, { name: 'friction-lifecycle' }, { name: 'friction-design' }, { name: 'priority-high' }] });
  await h.run();
  assert.deepEqual(h.mutations, [['remove', 'friction-lifecycle'], ['remove', 'friction-design'], ['add', ['friction-diagnostics', 'friction-auto']]]);
  h.mutations.length = 0;
  await h.run();
  assert.deepEqual(h.mutations, []);
  assert.ok(h.issue.labels.some(l => l.name === 'priority-high'));
});

test('rejects stale snapshots and an artifact for another issue before any writes', async () => {
  for (const overrides of [{ title: 'Updated' }, { body: 'New acceptance criteria' }]) {
    const h = harness(overrides);
    assert.equal((await h.run()).status, 'stale');
    assert.deepEqual(h.mutations, []);
  }
  const h = harness();
  h.input.issue.number = 99;
  await assert.rejects(h.run(), /issue/i);
  assert.deepEqual(h.mutations, []);
});

test('a closed or no-longer-friction issue loses only managed labels', async () => {
  for (const state of ['closed', 'open']) {
    const h = harness({ state, labels: [{ name: 'area-docs' }, { name: 'friction-auto' }, { name: 'friction-knowledge' }] });
    await h.run();
    assert.deepEqual(h.issue.labels, [{ name: 'area-docs' }]);
    assert.ok(h.mutations.every(m => m[0] === 'remove'));
  }
});

test('invalid or unsafe artifact routes revoke prior execution labels', async () => {
  for (const change of [{ category: 'lifecycle' }, { category: ['lifecycle'] }, { category: 'diagnostics', handling: 'execute' }, { probabilities: { category: 0.1, established: 0.1 } }]) {
    const h = harness({ labels: [{ name: 'friction' }, { name: 'friction-auto' }, { name: 'friction-diagnostics' }] });
    Object.assign(h.input.classification, change);
    assert.equal((await h.run()).status, 'cleared');
    assert.deepEqual(h.issue.labels.map(l => l.name), ['friction']);
  }
});

test('creates a missing managed label but propagates authentication errors', async () => {
  const h = harness();
  h.github.rest.issues.getLabel = async () => { throw Object.assign(new Error('missing'), { status: 404 }); };
  await h.run();
  assert.equal(h.mutations.filter(m => m[0] === 'create').length, 2);
  const denied = harness();
  denied.github.rest.issues.getLabel = async () => { throw Object.assign(new Error('denied'), { status: 403 }); };
  await assert.rejects(denied.run(), /denied/);
  assert.deepEqual(denied.mutations, []);
});

function labelApi(live) {
  const calls = [];
  const repo = { owner: 'hearsay-tools', repo: 'cezarion' };
  const github = { rest: { issues: {
    getLabel: async () => ({ data: live }),
    createLabel: async x => { calls.push(['create', x]); },
    updateLabel: async x => { calls.push(['update', x]); },
  } } };
  return { calls, repo, github };
}

test('updates an existing managed label whose description or color drifted from the policy', async () => {
  const design = LABELS.find(l => l.name === 'friction-design');
  for (const live of [
    { name: design.name, color: design.color, description: 'Investigate and propose behavior; await design approval before product implementation.' },
    { name: design.name, color: '000000', description: design.description },
  ]) {
    const { calls, repo, github } = labelApi(live);
    await ensureLabel(github, repo, design);
    assert.deepEqual(calls, [['update', { ...repo, name: design.name, color: design.color, description: design.description }]]);
  }
});

test('leaves a managed label alone when it differs only by trimmed space or color case', async () => {
  const regression = LABELS.find(l => l.name === 'friction-regression');
  const live = { name: regression.name, color: regression.color.toLowerCase(), description: regression.description.trim().slice(0, 100) };
  const { calls, repo, github } = labelApi(live);
  await ensureLabel(github, repo, { ...regression, description: `${regression.description} ` });
  assert.deepEqual(calls, []);
});

test('compares and writes a long description cut to 100 characters', async () => {
  const label = { name: 'friction-long', color: 'ABCDEF', description: `${'x'.repeat(99)}yz` };
  const synced = labelApi({ name: label.name, color: 'abcdef', description: `${'x'.repeat(99)}y` });
  await ensureLabel(synced.github, synced.repo, label);
  assert.deepEqual(synced.calls, []);
  const drifted = labelApi({ name: label.name, color: 'abcdef', description: 'short' });
  await ensureLabel(drifted.github, drifted.repo, label);
  assert.equal(drifted.calls[0][1].description, `${'x'.repeat(99)}y`);
});

test('propagates an error from updating a drifted label', async () => {
  const design = LABELS.find(l => l.name === 'friction-design');
  const { repo, github } = labelApi({ name: design.name, color: '000000', description: design.description });
  github.rest.issues.updateLabel = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
  await assert.rejects(ensureLabel(github, repo, design), /forbidden/);
});

test('rechecks eligibility and snapshot after remote label setup before mutations', async () => {
  for (const change of [issue => { issue.body = 'Different remedy'; }, issue => { issue.state = 'closed'; }, issue => { issue.labels = [{ name: 'area-cezar' }]; }]) {
    const h = harness();
    const getLabel = h.github.rest.issues.getLabel;
    h.github.rest.issues.getLabel = async x => { change(h.issue); return getLabel(x); };
    assert.equal((await h.run()).status, 'stale');
    assert.deepEqual(h.mutations, []);
  }
});

test('no-match classification applies the design fallback labels', async () => {
  const h = harness();
  h.input.classification.category = 'unclassified';
  h.input.classification.handling = 'design';
  await h.run();
  assert.deepEqual(h.mutations, [['add', ['friction-unclassified', 'friction-design']]]);
});

test('a failed classification clears prior execution labels without inventing judgments', async () => {
  const h = harness({ labels: [{ name: 'friction' }, { name: 'friction-auto' }, { name: 'friction-diagnostics' }, { name: 'bug' }] });
  h.input.classification = null;
  assert.equal((await h.run()).status, 'cleared');
  assert.deepEqual(h.issue.labels.map(l => l.name), ['friction', 'bug']);
});

test('failed classification revokes the captured route even when the body was edited', async () => {
  const h = harness({ body: 'New remedy', labels: [{ name: 'friction' }, { name: 'friction-auto' }, { name: 'friction-diagnostics' }] });
  h.input.classification = null;
  assert.equal((await h.run()).status, 'cleared');
  assert.deepEqual(h.issue.labels.map(l => l.name), ['friction']);
});

test('failed classification preserves a newer route that differs from its snapshot', async () => {
  const h = harness({ labels: [{ name: 'friction' }, { name: 'friction-auto' }, { name: 'friction-diagnostics' }] });
  h.input.classification = null;
  h.issue.labels = [{ name: 'friction' }, { name: 'friction-design' }, { name: 'friction-lifecycle' }];
  assert.equal((await h.run()).status, 'superseded');
  assert.deepEqual(h.mutations, []);
});
