const test = require('node:test');
const assert = require('node:assert/strict');
const {parseArgs, diagnose, recoveryNotice, main} = require('./ci-recovery.cjs');

const repo = 'hearsay-tools/squawk';
const now = Date.parse('2026-11-11T21:10:00Z');
const head = 'abc123';
const gate = (name, conclusion = 'success', id = 1) => ({id, name, status: 'completed', conclusion, created_at: '2026-11-11T20:10:00Z'});
const healthyJobs = () => [gate('Review preflight', 'success', 1), gate('Unit, build, E2E, and package', 'success', 2)];

function fake({runs = [], jobs = [], peers = [], annotations = {}}) {
  const calls = [];
  const request = endpoint => {
    calls.push(endpoint);
    if (endpoint === `/repos/${repo}/pulls/7`) return {head: {sha: head}};
    if (endpoint.startsWith(`/repos/${repo}/actions/workflows/ci.yml/runs?`)) return {workflow_runs: runs};
    if (endpoint.startsWith(`/repos/${repo}/actions/runs?`)) return {workflow_runs: peers};
    if (/\/attempts\/\d+\/jobs/.test(endpoint)) return {jobs};
    const annotated = endpoint.match(/check-runs\/(\d+)\/annotations$/);
    if (annotated) return annotations[annotated[1]] ?? [];
    throw new Error(`unexpected ${endpoint}`);
  };
  return {request, calls};
}

const run = (fields = {}) => ({id: 43093501386, run_attempt: 1, status: 'completed', conclusion: 'failure', created_at: '2026-11-11T20:07:18Z', ...fields});
const diagnosed = fixture => diagnose({repo, pr: 7}, {request: fake(fixture).request, now});

test('parseArgs requires a PR number and defaults the repository', () => {
  assert.deepEqual(parseArgs(['--pr', '7']), {pr: 7, repo});
  assert.deepEqual(parseArgs(['--pr', '7', '--repo', 'a/b']), {pr: 7, repo: 'a/b'});
  assert.throws(() => parseArgs([]), /--pr/);
  assert.throws(() => parseArgs(['--pr', '7', '--repo', 'a b']), /OWNER\/REPO/);
});

test('an abandoned need named by the gate notice gets a full rerun, not Re-run failed jobs', () => {
  const diagnosis = diagnosed({runs: [run({id: 42670804913})], jobs: [gate('Review preflight', 'success', 1), gate('Unit, build, E2E, and package', 'failure', 2)],
    annotations: {2: [{message: 'Review preflight was never created (abandoned). Re-run failed jobs cannot recreate it: run a full rerun (gh run rerun 42670804913) or push a new head.'}]}});
  assert.equal(diagnosis.kind, 'abandoned');
  assert.equal(recoveryNotice(diagnosis), [
    'Run 42670804913 attempt 1: Review preflight was never created (abandoned). "Re-run failed jobs" cannot recreate it.',
    'Recovery: a full rerun, without --failed: gh run rerun 42670804913 --repo hearsay-tools/squawk. If that attempt fails the same way, push a new head.',
  ].join('\n'));
});

test('a completed run without a gate job never created it', () => {
  const diagnosis = diagnosed({runs: [run()], jobs: [gate('Unit, build, E2E, and package', 'failure', 2)]});
  assert.deepEqual(diagnosis.needs, ['Review preflight']);
  assert.doesNotMatch(recoveryNotice(diagnosis), /gh run rerun \d+ --failed/);
});

test('a job queued past the bound gets close and reopen, never an empty commit', () => {
  const queued = {id: 3, name: 'Unit, build, E2E, and package', status: 'queued', conclusion: null, created_at: '2026-11-11T20:33:40Z'};
  const diagnosis = diagnosed({runs: [run()], jobs: [gate('Review preflight', 'success', 1), queued]});
  assert.deepEqual(diagnosis.jobs, [{name: 'Unit, build, E2E, and package', minutes: 36}]);
  assert.equal(recoveryNotice(diagnosis), [
    'Run 43093501386 attempt 1: Unit, build, E2E, and package (queued 36 min). A job normally starts within seconds; the bound is 15 min. GitHub cannot retry a run that ends with queued jobs.',
    'Recovery: close and reopen the PR for a fresh native run on the same head: gh pr close 7 --repo hearsay-tools/squawk && gh pr reopen 7 --repo hearsay-tools/squawk. Push a new head only if the new run also stays queued. Do not push an empty commit.',
  ].join('\n'));
});

test('a job queued within the bound is not stuck', () => {
  const queued = {id: 3, name: 'Typecheck', status: 'queued', conclusion: null, created_at: '2026-11-11T21:00:00Z'};
  const diagnosis = diagnosed({runs: [run({status: 'in_progress', conclusion: null})], jobs: [queued]});
  assert.equal(diagnosis.kind, 'other');
  assert.equal(recoveryNotice(diagnosis), 'Run 43093501386 attempt 1 is in_progress: no abandoned, startup-failed or stuck-queued job.\nWait for the run to complete.');
});

test('a run queued past the bound with no jobs is stuck as a whole', () => {
  const diagnosis = diagnosed({runs: [run({status: 'queued', conclusion: null, created_at: '2026-11-11T20:49:23Z'})], jobs: []});
  assert.deepEqual(diagnosis.jobs, [{name: 'The whole run', minutes: 20}]);
});

test('startup_failure on other PRs is GitHub-side; on this PR alone it is not', () => {
  const failed = run({conclusion: 'startup_failure', head_sha: head});
  const peer = (conclusion, sha = 'other') => ({head_sha: sha, status: 'completed', conclusion});
  const github = diagnosed({runs: [failed], peers: [peer('startup_failure'), peer('success'), peer('startup_failure', head)]});
  assert.deepEqual(github.peers, {failed: 1, total: 2});
  assert.match(recoveryNotice(github), /1 of 2 other PR runs in the last 2 h also ended startup_failure: the cause is GitHub-side\. Do not change the PR\./);
  assert.match(recoveryNotice(github), /gh pr close 7 --repo hearsay-tools\/squawk && gh pr reopen 7/);
  assert.match(recoveryNotice(diagnosed({runs: [failed], peers: [peer('success')]})), /None of 1 other PR runs .* in this PR or a repository setting/);
  assert.match(recoveryNotice(diagnosed({runs: [failed], peers: []})), /No other PR ran in the last 2 h, so the cause is unknown/);
});

test('the peer query covers the last two hours of pull_request_target runs', () => {
  const {request, calls} = fake({runs: [run({conclusion: 'startup_failure'})]});
  diagnose({repo, pr: 7}, {request, now});
  assert.ok(calls.includes(`/repos/${repo}/actions/runs?event=pull_request_target&created=%3E%3D2026-11-11T19:10:00Z&per_page=100`));
});

test('an ordinary failure keeps Re-run failed jobs, and the latest run decides', () => {
  const older = run({id: 1, created_at: '2026-11-11T19:00:00Z', conclusion: 'startup_failure'});
  const diagnosis = diagnosed({runs: [older, run()], jobs: [gate('Review preflight', 'failure', 1), gate('Unit, build, E2E, and package', 'failure', 2)]});
  assert.equal(diagnosis.kind, 'other');
  assert.match(recoveryNotice(diagnosis), /gh run rerun 43093501386 --failed --repo hearsay-tools\/squawk/);
});

test('a head without a native run gets close and reopen', () => {
  assert.match(recoveryNotice(diagnosed({runs: []})), /^PR #7 head abc123 has no native CI run\.\nRecovery: close and reopen/);
});

test('main prints the notice and reports a failed lookup', () => {
  const out = [];
  const err = [];
  assert.equal(main(['--pr', '7'], {request: fake({runs: [run()], jobs: healthyJobs()}).request, out: line => out.push(line), err: line => err.push(line)}), 0);
  assert.match(out[0], /no abandoned, startup-failed or stuck-queued job/);
  assert.equal(main(['--pr', '7'], {request: () => { throw new Error('gh failed'); }, out: line => out.push(line), err: line => err.push(line)}), 1);
  assert.deepEqual(err, ['ci-recovery: gh failed']);
});
