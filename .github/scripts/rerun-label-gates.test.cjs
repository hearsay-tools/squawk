'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { rerunLabelGates, matchingFailures, hasPendingGate, LABEL_GATES } = require('./rerun-label-gates.cjs');

const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);

function job(name, conclusion, steps = [], status = 'completed') {
  return { name, status, conclusion, steps: steps.map(([step, res]) => ({ name: step, status: 'completed', conclusion: res })) };
}

function harness({ pr, runs, jobsByAttempt, onRerun } = {}) {
  const state = {
    pr: pr ?? { number: 42, state: 'open', head: { sha: HEAD, ref: 'feat/a', repo: { full_name: 'hearsay-tools/squawk' } }, labels: [{ name: 'baseline-growth' }] },
    runs: runs ?? [{ id: 100, head_sha: HEAD, pull_requests: [{ number: 42 }], status: 'completed', conclusion: 'failure', run_attempt: 1 }],
    jobsByAttempt: jobsByAttempt ?? {
      1: [job('Check baseline growth and test budget', 'failure', [['Reject baseline growth', 'failure']])],
    },
    reruns: [],
    time: 0,
    sleeps: [],
  };
  const github = {
    request: async (route, params = {}) => {
      if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') return { data: structuredClone(state.pr) };
      if (route === 'GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs') {
        assert.equal(params.workflow_id, 'ci.yml');
        assert.equal(params.event, 'pull_request_target');
        return { data: { workflow_runs: structuredClone(state.runs) } };
      }
      if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}') {
        const found = state.runs.find(r => r.id === params.run_id);
        return { data: structuredClone(found) };
      }
      if (route === 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs') {
        const list = state.jobsByAttempt[params.attempt_number] ?? [];
        return { data: { total_count: list.length, jobs: structuredClone(list) } };
      }
      if (route === 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs') {
        state.reruns.push(params.run_id);
        if (onRerun) await onRerun(params.run_id, state);
        return { data: {} };
      }
      throw new Error(`Unexpected route: ${route}`);
    },
  };
  const run = (overrides = {}) => rerunLabelGates({
    github, owner: 'hearsay-tools', repo: 'squawk', pullNumber: 42, label: 'baseline-growth',
    waitMs: 120_000, pollMs: 30_000, now: () => state.time,
    sleep: async ms => { state.sleeps.push(ms); state.time += ms; if (overrides.onSleep) overrides.onSleep(state); },
    ...overrides,
  });
  return { state, run };
}

test('re-runs failed jobs when baseline-growth matches a failed baseline or complexity step', async () => {
  const baseline = harness();
  const res1 = await baseline.run();
  assert.equal(res1.action, 'rerun');
  assert.equal(res1.runId, 100);
  assert.deepEqual(baseline.state.reruns, [100]);

  const complexity = harness({
    jobsByAttempt: {
      1: [
        job('Check baseline growth and test budget', 'success', [['Reject baseline growth', 'success']]),
        job('Check function complexity', 'failure', [['Reject function complexity growth', 'failure']]),
      ],
    },
  });
  const res2 = await complexity.run();
  assert.equal(res2.action, 'rerun');
  assert.deepEqual(complexity.state.reruns, [100]);
});

test('test-budget re-runs only when the test-budget step failed, not on baseline-growth failures', async () => {
  const wrongStep = harness({
    pr: { number: 42, state: 'open', head: { sha: HEAD }, labels: [{ name: 'test-budget' }] },
    jobsByAttempt: { 1: [job('Check baseline growth and test budget', 'failure', [['Reject baseline growth', 'failure']])] },
  });
  assert.deepEqual(await wrongStep.run({ label: 'test-budget' }), { action: 'skip', reason: 'no-matching-failed-gate', runId: 100, attempt: 1 });
  assert.deepEqual(wrongStep.state.reruns, []);

  const rightStep = harness({
    pr: { number: 42, state: 'open', head: { sha: HEAD }, labels: [{ name: 'test-budget' }] },
    jobsByAttempt: {
      1: [job('Check baseline growth and test budget', 'failure', [
        ['Reject baseline growth', 'success'],
        ['Check the test line budget', 'failure'],
      ])],
    },
  });
  assert.equal((await rightStep.run({ label: 'test-budget' })).action, 'rerun');
  assert.deepEqual(rightStep.state.reruns, [100]);
});

test('skips unmapped labels, closed PRs, removed labels, missing runs, and non-failed runs', async () => {
  assert.equal((await harness().run({ label: 'auto-merge' })).reason, 'unmapped-label');
  assert.equal((await harness({ pr: { number: 42, state: 'closed', head: { sha: HEAD }, labels: [{ name: 'baseline-growth' }] } }).run()).reason, 'pr-not-open');
  assert.equal((await harness({ pr: { number: 42, state: 'open', head: { sha: HEAD }, labels: [] } }).run()).reason, 'label-removed');
  assert.equal((await harness({ runs: [] }).run()).reason, 'no-ci-run');
  assert.equal((await harness({ runs: [{ id: 100, status: 'completed', conclusion: 'success', run_attempt: 1 }] }).run()).reason, 'run-already-passed');
  assert.equal((await harness({ runs: [{ id: 100, status: 'completed', conclusion: 'startup_failure', run_attempt: 1 }] }).run()).reason, 'run-not-failed');
});

test('waits for an in-progress run whose label gate already failed, then re-runs once it completes', async () => {
  const h = harness({
    runs: [{ id: 100, status: 'in_progress', conclusion: null, run_attempt: 1 }],
  });
  let ticks = 0;
  const res = await h.run({
    onSleep: state => {
      if (++ticks === 2) state.runs[0] = { id: 100, status: 'completed', conclusion: 'failure', run_attempt: 1 };
    },
  });
  assert.equal(res.action, 'rerun');
  assert.deepEqual(h.state.sleeps, [30_000, 30_000]);
  assert.deepEqual(h.state.reruns, [100]);
});

test('exits immediately without waiting when in-progress CI already passed all jobs for that label', async () => {
  const h = harness({
    runs: [{ id: 100, status: 'in_progress', conclusion: null, run_attempt: 1 }],
    jobsByAttempt: {
      1: [
        job('Check baseline growth and test budget', 'success', [['Reject baseline growth', 'success']]),
        job('Check function complexity', 'success', [['Reject function complexity growth', 'success']]),
        job('Vitest shard 1/8', null, [], 'in_progress'),
      ],
    },
  });
  const res = await h.run();
  assert.deepEqual(res, { action: 'skip', reason: 'gate-already-passed', runId: 100, attempt: 1 });
  assert.deepEqual(h.state.sleeps, []);
  assert.deepEqual(h.state.reruns, []);
});

test('waits briefly while gated job is pending, then skips when it passes with the live label', async () => {
  const h = harness({
    runs: [{ id: 100, status: 'in_progress', conclusion: null, run_attempt: 1 }],
    jobsByAttempt: { 1: [job('Check baseline growth and test budget', null, [], 'in_progress')] },
  });
  const res = await h.run({
    onSleep: state => {
      state.jobsByAttempt[1] = [
        job('Check baseline growth and test budget', 'success', [['Reject baseline growth', 'success']]),
        job('Check function complexity', 'success', [['Reject function complexity growth', 'success']]),
      ];
    },
  });
  assert.deepEqual(res, { action: 'skip', reason: 'gate-already-passed', runId: 100, attempt: 1 });
  assert.deepEqual(h.state.sleeps, [30_000]);
});

test('stops waiting on head change, label removal, superseded run, or timeout', async () => {
  const moved = harness({ runs: [{ id: 100, status: 'in_progress', conclusion: null, run_attempt: 1 }] });
  assert.equal((await moved.run({ onSleep: s => { s.pr.head.sha = OTHER_HEAD; } })).reason, 'head-changed');

  const removed = harness({ runs: [{ id: 100, status: 'in_progress', conclusion: null, run_attempt: 1 }] });
  assert.equal((await removed.run({ onSleep: s => { s.pr.labels = []; } })).reason, 'label-removed');

  const superseded = harness({ runs: [{ id: 100, status: 'in_progress', conclusion: null, run_attempt: 1 }] });
  assert.equal((await superseded.run({
    onSleep: s => {
      s.runs[0] = { id: 100, status: 'completed', conclusion: 'failure', run_attempt: 1 };
      s.runs.push({ id: 101, status: 'in_progress', conclusion: null, run_attempt: 1 });
    },
  })).reason, 'run-superseded');

  const timedOut = harness({ runs: [{ id: 100, status: 'in_progress', conclusion: null, run_attempt: 1 }] });
  assert.equal((await timedOut.run({ waitMs: 60_000, pollMs: 30_000 })).reason, 'wait-timeout');
  assert.deepEqual(timedOut.state.reruns, []);
});

test('treats a 403/409 rerun race as already-rerunning only when the run is now active or on a newer attempt', async () => {
  const raced = harness({
    onRerun: (_id, state) => {
      state.runs[0] = { id: 100, status: 'in_progress', conclusion: null, run_attempt: 2 };
      const err = new Error('already running');
      err.status = 403;
      throw err;
    },
  });
  assert.deepEqual(await raced.run(), { action: 'skip', reason: 'already-rerunning', runId: 100, attempt: 2 });

  const realForbidden = harness({
    onRerun: () => {
      const err = new Error('Resource not accessible');
      err.status = 403;
      throw err;
    },
  });
  await assert.rejects(realForbidden.run(), /Resource not accessible/);
});

test('selects the newest run associated with this PR when another PR shares the same head SHA', async () => {
  const shared = harness({
    pr: { number: 42, state: 'open', head: { sha: HEAD, ref: 'feat/a', repo: { full_name: 'hearsay-tools/squawk' } }, labels: [{ name: 'baseline-growth' }] },
    runs: [
      { id: 100, head_sha: HEAD, pull_requests: [{ number: 42 }], status: 'completed', conclusion: 'failure', run_attempt: 1 },
      { id: 105, head_sha: HEAD, pull_requests: [{ number: 99 }], status: 'completed', conclusion: 'success', run_attempt: 1 },
    ],
  });
  const res = await shared.run();
  assert.equal(res.action, 'rerun');
  assert.equal(res.runId, 100);
  assert.deepEqual(shared.state.reruns, [100]);

  const fork = harness({
    pr: { number: 42, state: 'open', head: { sha: HEAD, ref: 'fork-branch', repo: { full_name: 'contrib/squawk' } }, labels: [{ name: 'baseline-growth' }] },
    runs: [
      { id: 100, head_sha: HEAD, head_branch: 'fork-branch', head_repository: { full_name: 'contrib/squawk' }, pull_requests: [], status: 'completed', conclusion: 'failure', run_attempt: 1 },
      { id: 105, head_sha: HEAD, head_branch: 'other-branch', head_repository: { full_name: 'hearsay-tools/squawk' }, pull_requests: [], status: 'completed', conclusion: 'success', run_attempt: 1 },
    ],
  });
  assert.equal((await fork.run()).runId, 100);
  assert.deepEqual(fork.state.reruns, [100]);
});

test('matchingFailures and hasPendingGate cover multi-gate labels accurately', () => {
  const gates = LABEL_GATES['baseline-growth'];
  assert.equal(hasPendingGate([], gates), true);
  assert.equal(matchingFailures([], gates).length, 0);
  const done = [
    job('Check baseline growth and test budget', 'success', [['Reject baseline growth', 'success']]),
    job('Check function complexity', 'failure', [['Reject function complexity growth', 'failure']]),
  ];
  assert.equal(hasPendingGate(done, gates), false);
  assert.deepEqual(matchingFailures(done, gates).map(g => g.step), ['Reject function complexity growth']);
});
