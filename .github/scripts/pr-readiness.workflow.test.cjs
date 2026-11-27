'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');
const { readinessState, readinessData } = require('./pr-readiness.testkit.cjs');
const read = name => yaml.parse(fs.readFileSync(path.join(__dirname, '../workflows', name), 'utf8'));

test('PR Readiness has only trusted default-branch triggers and no repository write', () => {
  const w = read('pr-readiness.yml'), job = w.jobs.sync, discovery = w.jobs.discover;
  assert.equal(w.name, 'PR Readiness');
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(Object.keys(w.on).sort(), ['pull_request_target', 'workflow_dispatch', 'workflow_run']);
  assert.deepEqual(w.on.workflow_run, { workflows: ['CI', 'Review signal'], types: ['completed'] });
  // Human draft/ready flips, new heads and pre-pr-review label changes resync the board.
  assert.deepEqual(w.on.pull_request_target, {
    types: ['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft', 'labeled', 'unlabeled'],
    branches: ['main'],
  });
  assert.equal(w.on.workflow_dispatch.inputs.pr_number.required, true);
  assert.equal(w.concurrency, undefined, 'discovery cannot be coalesced across PRs');
  assert.deepEqual(job.concurrency, { group: 'pr-readiness-pr-${{ matrix.pr }}', 'cancel-in-progress': false });
  assert.equal(job.needs, 'discover');
  assert.equal(job.if, "needs.discover.outputs.numbers != '[]'");
  assert.deepEqual(job.strategy, { 'fail-fast': false, 'max-parallel': 4,
    matrix: { pr: '${{ fromJSON(needs.discover.outputs.numbers) }}' } });
  assert.equal(discovery.concurrency, undefined, 'each event discovers independently');
  assert.equal(discovery.if,
    "github.event_name != 'pull_request_target' || (github.event.action != 'labeled' && github.event.action != 'unlabeled') || github.event.label.name == 'pre-pr-review'",
    'unrelated label events skip discovery');
  assert.deepEqual(discovery.permissions, { contents: 'read', 'pull-requests': 'read', actions: 'read' });
  assert.deepEqual(discovery.outputs, { numbers: '${{ steps.discover.outputs.numbers }}' });
  assert.deepEqual(job.permissions, { contents: 'read', 'pull-requests': 'read', checks: 'read', statuses: 'read' });
  for (const permissions of [discovery.permissions, job.permissions]) {
    assert.ok(Object.values(permissions).every(access => access === 'read'), 'GITHUB_TOKEN never writes');
  }
  const appToken = (step, permissions) => {
    assert.equal(step['continue-on-error'], true, 'a missing App or permission degrades, never fails the job');
    assert.equal(step.if, "vars.RELEASE_APP_CLIENT_ID != ''");
    assert.equal(step.with['client-id'], '${{ vars.RELEASE_APP_CLIENT_ID }}');
    assert.equal(step.with['private-key'], '${{ secrets.RELEASE_APP_PRIVATE_KEY }}');
    assert.deepEqual(Object.keys(step.with).filter(key => key.startsWith('permission-')).map(key => [key, step.with[key]]), permissions);
  };
  const reads = names => names.map(name => [`permission-${name}`, 'read']);
  const [discoverCheckout, discoverToken, discoverScript] = discovery.steps;
  appToken(discoverToken, reads(['actions', 'pull-requests']));
  assert.equal(discoverScript.env.READ_TOKEN, '${{ steps.read_app.outputs.token }}');
  assert.match(discoverScript.with.script, /process\.env\.READ_TOKEN \? getOctokit\(process\.env\.READ_TOKEN\) : github/);
  assert.match(discoverScript.with.script, /await discover\(\{ github: reads/);
  assert.match(discoverScript.with.script, /core.setOutput\('numbers'/);
  const [checkout, readToken, boardToken, script] = job.steps;
  appToken(readToken, reads(['checks', 'contents', 'pull-requests', 'statuses']));
  appToken(boardToken, [['permission-organization-projects', 'write']]);
  assert.equal(script.env.READ_TOKEN, '${{ steps.read_app.outputs.token }}');
  assert.equal(script.env.BOARD_TOKEN, '${{ steps.board_app.outputs.token }}');
  assert.deepEqual(Object.keys(script.env), ['READ_TOKEN', 'BOARD_TOKEN', 'READINESS_PR'], 'queue only PR identity');
  assert.equal(script.env.READINESS_PR, '${{ matrix.pr }}');
  assert.match(script.with.script, /syncPull\(\{ github: reads, projectGithub,/);
  assert.doesNotMatch(script.with.script, /payload:|head_sha|head\.sha/);
  for (const [stepCheckout, steps] of [[discoverCheckout, discovery.steps], [checkout, job.steps]]) {
    assert.equal(stepCheckout.with.ref, '${{ github.event.repository.default_branch }}', 'the script always comes from main');
    assert.equal(stepCheckout.with['persist-credentials'], false);
    assert.equal(steps.filter(step => String(step.uses).startsWith('actions/checkout')).length, 1, 'no PR code is checked out');
    for (const step of steps) assert.match(step.uses, /@[0-9a-f]{40}$/, `${step.name ?? step.id} must be pinned to a commit`);
    assert.equal(steps.at(-1).with.retries, 0);
  }
  assert.doesNotMatch(JSON.stringify(w), /refs\/pull\//);
  assert.deepEqual([...JSON.stringify(w).matchAll(/secrets\.(\w+)/g)].map(m => m[1]), ['RELEASE_APP_PRIVATE_KEY', 'RELEASE_APP_PRIVATE_KEY', 'RELEASE_APP_PRIVATE_KEY']);
});

test('PR-context review signals have no permissions, secrets, checkout or trusted outputs and debounce per PR', () => {
  const w = read('review-signal.yml');
  assert.equal(w.name, 'Review signal');
  assert.deepEqual(w.permissions, {});
  assert.deepEqual(w.jobs.signal.permissions, {});
  assert.deepEqual(w.jobs.signal.steps, [{ run: 'sleep 30' }]);
  assert.ok(w.jobs.signal['timeout-minutes'] >= 1, 'the settle step fits the job timeout');
  assert.deepEqual(w.jobs.signal.concurrency, {
    group: 'review-signal-pr-${{ github.event.pull_request.number }}', 'cancel-in-progress': true });
  assert.equal(w.concurrency, undefined, 'only the per-PR job debounces');
  assert.deepEqual(w.on.pull_request_review.types, ['submitted', 'edited', 'dismissed']);
  assert.deepEqual(w.on.pull_request_review_comment.types, ['created', 'edited', 'deleted']);
  assert.doesNotMatch(JSON.stringify(w), /secrets\.|checkout|outputs/);
});

// The workflow scripts run here as github-script runs them. Each fake token is a
// minimal Octokit whose `request` and `graphql` pass through `hook.wrap`.
function token(s, remaining, { project = false } = {}) {
  let send = async ({ method, url, ...params }) => {
    const route = `${method} ${url}`;
    s.calls.push([route, params]);
    if (s.failAll) throw new Error('API unavailable');
    if (route === 'GET /rate_limit') return { data: { resources: { core: { remaining, reset: 1 } } } };
    if (project) return { headers: { 'x-ratelimit-resource': 'graphql', 'x-ratelimit-remaining': '4999' }, data: { data: {} } };
    return { headers: { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': String(--remaining) },
      data: structuredClone(readinessData(s, route, params)) };
  };
  const request = (route, params = {}) => { const [method, url] = route.split(' '); return send({ method, url, ...params }); };
  return { request, graphql: async (query, variables) => (await request('POST /graphql', { query, ...variables })).data.data,
    hook: { wrap(name, wrapper) { assert.equal(name, 'request'); const inner = send; send = options => wrapper(inner, options); } } };
}
async function runJob(jobName, { s, github, env, tokens = {} }) {
  const step = read('pr-readiness.yml').jobs[jobName].steps.at(-1);
  const info = [], outputs = {};
  const core = { info: message => info.push(message), setOutput: (key, value) => { outputs[key] = value; } };
  const context = { repo: { owner: 'o', repo: 'r' }, eventName: 'workflow_dispatch',
    payload: { repository: { full_name: 'o/r' }, inputs: { pr_number: '7' } } };
  let error;
  try {
    // runJob is itself async, so its constructor builds the step's async script.
    await new runJob.constructor('require', 'github', 'context', 'core', 'getOctokit', 'process', step.with.script)(
      p => require(path.resolve(__dirname, '../..', p)), github, context, core, value => tokens[value],
      { env: { ...step.env, ...env } });
  } catch (caught) { error = caught; }
  return { info, outputs, error, s };
}
test('discovery logs one call count per token and counts the App when it serves the reads', async () => {
  const s = readinessState(), github = token(s, 4000), app = token(s, 9000);
  const job = await runJob('discover', { s, github, env: { READ_TOKEN: 'app' }, tokens: { app } });
  assert.equal(job.error, undefined);
  assert.equal(job.outputs.numbers, '[7]');
  assert.deepEqual(job.info.slice(-2), ['GITHUB_TOKEN: GitHub API calls: 0 (core remaining unknown)',
    'Release App token (reads): GitHub API calls: 1 (core remaining 8999)']);
  const fallback = await runJob('discover', { s, github, env: { READ_TOKEN: '' } });
  assert.deepEqual(fallback.info.slice(-1), ['GITHUB_TOKEN: GitHub API calls: 1 (core remaining 3999)']);
});
test('a failed discovery still logs its call count', async () => {
  const s = readinessState(); s.failAll = true;
  const job = await runJob('discover', { s, github: token(s, 4000), env: { READ_TOKEN: '' } });
  assert.match(job.error.message, /API unavailable/);
  assert.deepEqual(job.info.slice(-1), ['GITHUB_TOKEN: GitHub API calls: 1 (core remaining unknown)']);
});
test('the per-PR job counts each token and skips the sync under the read token floor', async () => {
  const s = readinessState(), github = token(s, 4000), app = token(s, 700), board = token(s, 0, { project: true });
  const job = await runJob('sync', { s, github, env: { READ_TOKEN: 'app', BOARD_TOKEN: 'board', READINESS_PR: '7' },
    tokens: { app, board } });
  assert.equal(job.error, undefined);
  assert.ok(job.info.includes('"under-floor"'));
  assert.ok(job.info.some(line => /^PR 7: board sync skipped: core remaining 699 on the read token is under the floor of 800/.test(line)));
  assert.deepEqual(job.info.slice(-3), ['GITHUB_TOKEN: GitHub API calls: 0 (core remaining unknown)',
    'Release App token (reads): GitHub API calls: 1 (core remaining 699)',
    'Release App token (board): GitHub API calls: 0 (core remaining unknown)']);
});
test('the per-PR job syncs the board above the floor and counts its project calls', async () => {
  const s = readinessState(), github = token(s, 4000), board = token(s, 0, { project: true });
  const job = await runJob('sync', { s, github, env: { READ_TOKEN: '', BOARD_TOKEN: 'board', READINESS_PR: '7' },
    tokens: { board } });
  assert.equal(job.error, undefined);
  assert.equal(job.info.some(line => /board sync skipped: core remaining/.test(line)), false);
  assert.ok(job.info.includes('"In review"'));
  const [reads, boardLine] = job.info.slice(-2);
  assert.equal(reads, 'GITHUB_TOKEN: GitHub API calls: 6 (core remaining 3994)', 'without the App, GITHUB_TOKEN serves the reads');
  assert.match(boardLine, /^Release App token \(board\): GitHub API calls: [1-9]\d* \(core remaining unknown\)$/);
});
test('without a board token the per-PR job reads nothing', async () => {
  const s = readinessState(), github = token(s, 4000);
  const job = await runJob('sync', { s, github, env: { READ_TOKEN: '', BOARD_TOKEN: '', READINESS_PR: '7' } });
  assert.equal(job.error, undefined);
  assert.ok(job.info.includes('"no-token"'));
  assert.deepEqual(job.info.slice(-1), ['GITHUB_TOKEN: GitHub API calls: 0 (core remaining unknown)']);
});
