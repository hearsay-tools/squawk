'use strict';
// The arming check in .ai/skills/auto-merge/arm-check.mjs: auto-merge is armed only
// while no review thread on the pull request is unresolved.
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
const args = (github, readHead = async () => HEAD) => ({ github, readHead, owner: 'o', repo: 'r', pullNumber: 7 });

test('arms the head when every review thread is resolved', async () => {
  const { decideArm } = await load();
  const result = await decideArm(args(threadPages([thread('t1', true), thread('t2', true)])));
  assert.deepEqual(result, { arm: true, head: HEAD, reasons: [] });
});

test('arms a pull request with no review thread', async () => {
  const { decideArm } = await load();
  assert.equal((await decideArm(args(threadPages([])))).arm, true);
});

test('refuses while one thread is unresolved, outdated or not', async () => {
  const { decideArm } = await load();
  const result = await decideArm(args(threadPages([thread('t1', true), thread('t2', false)])));
  assert.equal(result.arm, false);
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

test('refuses when the head moves during the check', async () => {
  const { decideArm } = await load();
  const heads = [HEAD, 'b'.repeat(40)];
  const result = await decideArm(args(threadPages([]), async () => heads.shift()));
  assert.equal(result.arm, false);
  assert.match(result.reasons[0], /the head moved/);
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
else process.stdout.write(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
  nodes: fixture.threads, pageInfo: { hasNextPage: false, endCursor: null } } } } } }));
`, { mode: 0o755 });
  return spawnSync(process.execPath, [script, ...cliArgs], {
    encoding: 'utf8', env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` },
  });
}

test('the command prints ARM with the head and exits 0', (t) => {
  const run = runCli(t, { head: HEAD, threads: [thread('t1', true)] }, ['--pr', '7']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout, `ARM ${HEAD}\n`);
});

test('the command prints DO NOT ARM and exits 1 on an unresolved thread', (t) => {
  const run = runCli(t, { head: HEAD, threads: [thread('t1', false)] }, ['--pr', '7', '--repo', 'o/r']);
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout, 'DO NOT ARM\n- 1 unresolved review thread: answer each one first\n');
});

test('the command exits 2 when gh fails or the number is missing', (t) => {
  const failed = runCli(t, { fail: 'HTTP 502' }, ['--pr', '7']);
  assert.equal(failed.status, 2);
  assert.equal(failed.stdout, 'DO NOT ARM\n- the check failed: HTTP 502\n');
  const missing = runCli(t, { head: HEAD, threads: [] }, ['--pr', 'seven']);
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /pass --pr <number>/);
});
