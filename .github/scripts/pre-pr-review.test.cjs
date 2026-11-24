'use strict';
// The pre-PR review status helper (hearsay-tools/squawk#4191).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REVIEW_CONTEXT, BANNER_START, BANNER_END, bannerBody, parse, description, run } = require('./pre-pr-review.cjs');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TASK = 'c5aff4f7-9a93-4dbe-9939-12f048ff0bad';

// A gh double: records each call and answers `pr view` from `pull`.
function fakeGh(pull = { body: 'Closes #1', headRefOid: HEAD }) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'repo') return 'o/r\n';
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pull);
    return '';
  };
  return { calls, gh };
}
const statusCall = calls => calls.find(({ args }) => args[0] === 'api');
const edits = calls => calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'edit');

test('each action sets its state on the reviewed head under the pre-pr-review context', () => {
  for (const [action, state] of [['open', 'pending'], ['clean', 'success'], ['blocked', 'failure']]) {
    const { calls, gh } = fakeGh();
    assert.equal(run({ action, head: HEAD, pr: null, repo: null, taskId: TASK, gh, log: () => {} }).status, state);
    const { args } = statusCall(calls);
    assert.deepEqual(args.slice(0, 4), ['api', '-X', 'POST', `repos/o/r/statuses/${HEAD}`]);
    assert.ok(args.includes(`state=${state}`));
    assert.ok(args.includes(`context=${REVIEW_CONTEXT}`));
    assert.equal(edits(calls).length, 0, 'no PR, no body edit');
  }
});

test('the description names the short task id and nothing else from the environment', () => {
  assert.equal(description('open', TASK), 'Review round open (task c5aff4f7)');
  assert.equal(description('clean', undefined), 'Review round clean');
  assert.equal(description('blocked', 'not a task; $(id)'), 'Review found a finding scored 5 or more');
});

test('open writes the banner on top and keeps the body', () => {
  const { calls, gh } = fakeGh();
  assert.equal(run({ action: 'open', head: HEAD, pr: 7, repo: 'o/r', taskId: TASK, gh, log: () => {} }).banner, 'written');
  const [edit] = edits(calls);
  assert.deepEqual(edit.args, ['pr', 'edit', '7', '--repo', 'o/r', '--body-file', '-']);
  assert.ok(edit.input.startsWith(`${BANNER_START}\n`));
  assert.match(edit.input, /Review open/);
  assert.ok(edit.input.endsWith(`${BANNER_END}\n\nCloses #1`));
});

test('blocked replaces the open banner, and clean removes it and restores the body', () => {
  const opened = bannerBody('Body\n\nmore', 'open');
  const blocked = bannerBody(opened, 'blocked');
  assert.equal(blocked.split(BANNER_START).length, 2, 'one banner only');
  assert.match(blocked, /scored 5 or more/);
  assert.doesNotMatch(blocked, /Review open/);
  assert.equal(bannerBody(blocked, 'clean'), 'Body\n\nmore');
  assert.equal(bannerBody(bannerBody(opened, 'open'), 'clean'), 'Body\n\nmore');
});

test('clean on a body without a banner edits nothing', () => {
  const { calls, gh } = fakeGh({ body: 'Plain', headRefOid: HEAD });
  assert.equal(run({ action: 'clean', head: HEAD, pr: 7, repo: 'o/r', taskId: TASK, gh, log: () => {} }).banner, 'unchanged');
  assert.equal(edits(calls).length, 0);
  assert.equal(bannerBody(null, 'clean'), '');
  assert.equal(bannerBody(`x ${BANNER_START} unterminated`, 'clean'), `x ${BANNER_START} unterminated`);
});

test('a PR whose live head moved keeps its banner, and the status still lands on the reviewed head', () => {
  const { calls, gh } = fakeGh({ body: 'Body', headRefOid: OTHER });
  const logs = [];
  assert.equal(run({ action: 'clean', head: HEAD, pr: 7, repo: 'o/r', taskId: TASK, gh, log: m => logs.push(m) }).banner, 'other-head');
  assert.equal(edits(calls).length, 0);
  assert.ok(statusCall(calls).args.includes(`repos/o/r/statuses/${HEAD}`));
  assert.match(logs.at(-1), /banner is unchanged/);
});

test('parse refuses an unknown action, a short head and a bad PR number', () => {
  assert.deepEqual(parse(['open', '--head', HEAD, '--pr', '7']), { action: 'open', head: HEAD, pr: 7, repo: null });
  assert.throws(() => parse(['start', '--head', HEAD]), /open, clean or blocked/);
  assert.throws(() => parse(['open', 'clean', '--head', HEAD]), /open, clean or blocked/);
  assert.throws(() => parse(['open', '--head', 'abc']), /--head/);
  assert.throws(() => parse(['open', '--head', HEAD, '--pr', '0']), /--pr/);
});

test('the command exits 2 with one line on bad arguments', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'pre-pr-review.cjs'), 'open'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^pre-pr-review: pass --head/);
});
