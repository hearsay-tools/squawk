'use strict';
// The arming check in .ai/skills/auto-merge/arm-check.mjs: auto-merge is armed only
// while no review thread on the pull request is unresolved and CodeRabbit is not still
// reviewing the head.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const script = path.resolve(__dirname, '../../.ai/skills/auto-merge/arm-check.mjs');
const load = () => import(pathToFileURL(script).href);
const HEAD = 'a'.repeat(40);

// A GitHub fake that serves review-thread pages in order.
function threadPages(...pages) {
  const calls = [];
  return {
    calls,
    graphql: async (_query, variables) => {
      calls.push(variables);
      const nodes = pages[calls.length - 1];
      const last = calls.length === pages.length;
      return { repository: { pullRequest: { reviewThreads: {
        nodes, pageInfo: { hasNextPage: !last, endCursor: last ? null : `cursor-${calls.length}` },
      } } } };
    },
  };
}
const thread = (id, isResolved) => ({ id, isResolved });
const coderabbit = (status) => ({ name: 'CodeRabbit', app: { slug: 'coderabbitai' }, status });
const args = (github, readHead = async () => HEAD, runs = [coderabbit('completed')], review = null) => ({
  github, reviewedHead: HEAD, readHead, readCheckRuns: async (sha) => { assert.equal(sha, HEAD); return runs; },
  readReviewStatus: async (sha) => { assert.equal(sha, HEAD); return review; }, owner: 'o', repo: 'r', pullNumber: 7,
});

test('arms the head when every review thread is resolved', async () => {
  const { decideArm } = await load();
  const result = await decideArm(args(threadPages([thread('t1', true), thread('t2', true)])));
  assert.deepEqual(result, { outcome: 'arm', head: HEAD, reasons: [] });
});

test('arms a pull request with no review thread and no CodeRabbit check run', async () => {
  const { decideArm } = await load();
  assert.equal((await decideArm(args(threadPages([]), undefined, []))).outcome, 'arm');
});

test('waits while CodeRabbit is queued or reviewing the head', async () => {
  const { decideArm } = await load();
  for (const status of ['queued', 'in_progress']) {
    const result = await decideArm(args(threadPages([thread('t1', true)]), undefined, [coderabbit(status)]));
    assert.equal(result.outcome, 'wait');
    assert.deepEqual(result.reasons, [`CodeRabbit is reviewing ${HEAD}: run the check again when its check run completes`]);
  }
});

test('reads the CodeRabbit check run before the review threads', async () => {
  const { decideArm } = await load();
  const order = [];
  const github = { graphql: async (...call) => { order.push('threads'); return threadPages([]).graphql(...call); } };
  await decideArm({ ...args(github), readCheckRuns: async () => { order.push('runs'); return []; } });
  assert.deepEqual(order, ['runs', 'threads']);
});

test('a check run of the same name from another app does not hold arming', async () => {
  const { decideArm } = await load();
  const other = { name: 'CodeRabbit', app: { slug: 'someone-else' }, status: 'in_progress' };
  assert.equal((await decideArm(args(threadPages([]), undefined, [other]))).outcome, 'arm');
});

test('an unresolved thread refuses even while CodeRabbit still reviews', async () => {
  const { decideArm } = await load();
  const result = await decideArm(args(threadPages([thread('t1', false)]), undefined, [coderabbit('in_progress')]));
  assert.equal(result.outcome, 'refuse');
});

test('refuses while one thread is unresolved, outdated or not', async () => {
  const { decideArm } = await load();
  const result = await decideArm(args(threadPages([thread('t1', true), thread('t2', false)])));
  assert.equal(result.outcome, 'refuse');
  assert.deepEqual(result.reasons, ['1 unresolved review thread: answer each one first']);
});

test('reads every page of threads before it decides', async () => {
  const { decideArm } = await load();
  const first = Array.from({ length: 100 }, (_, i) => thread(`t${i}`, true));
  const github = threadPages(first, [thread('late', false), thread('later', false)]);
  const result = await decideArm(args(github));
  assert.equal(github.calls.length, 2);
  assert.equal(github.calls[1].cursor, 'cursor-1');
  assert.deepEqual(result.reasons, ['2 unresolved review threads: answer each one first']);
});

test('refuses when the live head is not the reviewed head, before any other read', async () => {
  const { decideArm } = await load();
  const github = threadPages([]);
  const result = await decideArm(args(github, async () => 'b'.repeat(40)));
  assert.equal(result.outcome, 'refuse');
  assert.deepEqual(result.reasons, [`the head is ${'b'.repeat(40)}, not the reviewed head ${HEAD}: decide again for the new head`]);
  assert.equal(github.calls.length, 0);
});

test('refuses when the head moves during the check', async () => {
  const { decideArm } = await load();
  const heads = [HEAD, 'b'.repeat(40)];
  const result = await decideArm(args(threadPages([]), async () => heads.shift()));
  assert.equal(result.outcome, 'refuse');
  assert.match(result.reasons[0], /the head moved/);
});

test('refuses while the pre-PR review round is open or blocked, and arms once it is clean', async () => {
  const { decideArm } = await load();
  const open = await decideArm(args(threadPages([]), undefined, undefined, 'pending'));
  assert.deepEqual(open, { outcome: 'refuse', head: HEAD, reasons: [`the pre-pr-review round on ${HEAD} is still open: arm only after it is clean`] });
  for (const state of ['failure', 'error']) {
    const blocked = await decideArm(args(threadPages([]), undefined, undefined, state));
    assert.equal(blocked.outcome, 'refuse');
    assert.match(blocked.reasons[0], /found a finding scored 5 or more/);
  }
  assert.equal((await decideArm(args(threadPages([]), undefined, undefined, 'success'))).outcome, 'arm');
});

test('a malformed thread page is an error, not a decision', async () => {
  const { decideArm } = await load();
  await assert.rejects(decideArm(args(threadPages([{ id: 't1' }]))), /Malformed review thread/);
});

// Runs the script with a fake `gh` first on PATH. The fake answers from fixture JSON.
function runCli(t, fixture, cliArgs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arm-check-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(fixture));
  const fake = path.join(dir, 'gh');
  fs.writeFileSync(fake, `#!${process.execPath}
const fixture = require(${JSON.stringify(path.join(dir, 'fixture.json'))});
const argv = process.argv.slice(2);
if (fixture.fail) { process.stderr.write(fixture.fail + '\\n'); process.exit(1); }
if (argv[0] === 'repo') process.stdout.write('o/r\\n');
else if (argv[0] === 'pr') process.stdout.write(fixture.head + '\\n');
else if (argv[1] === 'repos/o/r/commits/' + fixture.head + '/status?per_page=100') {
  process.stdout.write(JSON.stringify({ statuses: fixture.statuses ?? [] }));
}
else if (argv[1] !== 'graphql') {
  if (argv[1] !== 'repos/o/r/commits/' + fixture.head + '/check-runs?check_name=CodeRabbit&per_page=100') process.exit(3);
  process.stdout.write(JSON.stringify({ check_runs: fixture.runs ?? [] }));
}
else process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
  nodes: fixture.threads, pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
`, { mode: 0o755 });
  return spawnSync(process.execPath, [script, ...cliArgs], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
  });
}

test('the command prints ARM with the head and exits 0', (t) => {
  const run = runCli(t, { head: HEAD, threads: [thread('t1', true)] }, ['--pr', '7', '--head', HEAD]);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `ARM ${HEAD}\n`);
});

test('the command prints DO NOT ARM and exits 1 on an unresolved thread', (t) => {
  const run = runCli(t, { head: HEAD, threads: [thread('t1', false)] }, ['--pr', '7', '--head', HEAD, '--repo', 'o/r']);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, 'DO NOT ARM\n- 1 unresolved review thread: answer each one first\n');
});

test('the command prints WAIT and exits 1 while CodeRabbit reviews the head', (t) => {
  const run = runCli(t, { head: HEAD, threads: [], runs: [coderabbit('in_progress')] }, ['--pr', '7', '--head', HEAD]);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, `WAIT\n- CodeRabbit is reviewing ${HEAD}: run the check again when its check run completes\n`);
});

test('the command prints DO NOT ARM and exits 1 while the review round is open', (t) => {
  const run = runCli(t, { head: HEAD, threads: [], statuses: [{ context: 'CodeRabbit', state: 'pending' }, { context: 'pre-pr-review', state: 'pending' }] },
    ['--pr', '7', '--head', HEAD]);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, `DO NOT ARM\n- the pre-pr-review round on ${HEAD} is still open: arm only after it is clean\n`);
});

test('the command exits 2 when gh fails or the number is missing', (t) => {
  const failed = runCli(t, { fail: 'HTTP 502' }, ['--pr', '7', '--head', HEAD]);
  assert.equal(failed.status, 2);
  assert.equal(failed.stdout, 'DO NOT ARM\n- the check failed: HTTP 502\n');
  const missing = runCli(t, { head: HEAD, threads: [] }, ['--pr', 'seven', '--head', HEAD]);
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /pass --pr <number>/);
  const noHead = runCli(t, { head: HEAD, threads: [] }, ['--pr', '7']);
  assert.equal(noHead.status, 2);
  assert.match(noHead.stdout, /pass --head <the reviewed 40-character sha>/);
});
