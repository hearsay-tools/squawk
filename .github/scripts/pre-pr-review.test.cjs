'use strict';
// The pre-PR review label and banner helper (hearsay-tools/squawk#4394).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REVIEW_LABEL, BANNER_START, BANNER_END, bannerBody, parse, run } = require('./pre-pr-review.cjs');

// A gh double: records each call and answers `pr view` from `pull`.
function fakeGh(pull = { body: 'Closes #1', labels: [] }) {
  const calls = [];
  const gh = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'repo') return 'o/r\n';
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pull);
    return '';
  };
  return { calls, gh };
}
const apiCalls = calls => calls.filter(({ args }) => args[0] === 'api');
const edits = calls => calls.filter(({ args }) => args[0] === 'pr' && args[1] === 'edit');

test('open adds the pre-pr-review label, writes the open banner, and sets no commit status', () => {
  const { calls, gh } = fakeGh();
  const logs = [];
  const result = run({ action: 'open', pr: 7, repo: null, gh, log: line => logs.push(line) });
  assert.deepEqual(result, { label: 'added', banner: 'written' });
  const apis = apiCalls(calls);
  assert.equal(apis.length, 1);
  assert.deepEqual(apis[0].args, ['api', '-X', 'POST', 'repos/o/r/issues/7/labels', '-f', `labels[]=${REVIEW_LABEL}`]);
  assert.equal(calls.some(({ args }) => args.some(arg => String(arg).includes('/statuses/'))), false, 'no commit status');
  const [edit] = edits(calls);
  assert.deepEqual(edit.args, ['pr', 'edit', '7', '--repo', 'o/r', '--body-file', '-']);
  assert.ok(edit.input.startsWith(`${BANNER_START}\n`));
  assert.match(edit.input, /Review open/);
  assert.ok(edit.input.endsWith(`${BANNER_END}\n\nCloses #1`));
  const labelIndex = calls.indexOf(apis[0]);
  const editIndex = calls.indexOf(edit);
  assert.ok(labelIndex < editIndex, 'label blocks the PR before the body edit');
});

test('blocked adds the label when missing, skips adding when present, and writes the blocked banner', () => {
  const fresh = fakeGh();
  assert.deepEqual(run({ action: 'blocked', pr: 7, repo: 'o/r', gh: fresh.gh, log: () => {} }), { label: 'added', banner: 'written' });
  assert.deepEqual(apiCalls(fresh.calls)[0].args, ['api', '-X', 'POST', 'repos/o/r/issues/7/labels', '-f', `labels[]=${REVIEW_LABEL}`]);
  assert.match(edits(fresh.calls)[0].input, /scored 5 or more/);

  const alreadyOpen = fakeGh({ body: bannerBody('Closes #1', 'open'), labels: [{ name: REVIEW_LABEL }] });
  assert.deepEqual(run({ action: 'blocked', pr: 7, repo: 'o/r', gh: alreadyOpen.gh, log: () => {} }),
    { label: 'unchanged', banner: 'written' });
  assert.equal(apiCalls(alreadyOpen.calls).length, 0, 'label already present');
  assert.match(edits(alreadyOpen.calls)[0].input, /scored 5 or more/);
  assert.doesNotMatch(edits(alreadyOpen.calls)[0].input, /Review open/);
});

test('clean removes the banner before removing the label, and sets no commit status', () => {
  const { calls, gh } = fakeGh({ body: bannerBody('Body\n\nmore', 'blocked'), labels: [{ name: 'bug' }, { name: REVIEW_LABEL }] });
  assert.deepEqual(run({ action: 'clean', pr: 7, repo: 'o/r', gh, log: () => {} }), { label: 'removed', banner: 'removed' });
  const [edit] = edits(calls);
  const [del] = apiCalls(calls);
  assert.equal(edit.input, 'Body\n\nmore');
  assert.deepEqual(del.args, ['api', '-X', 'DELETE', `repos/o/r/issues/7/labels/${REVIEW_LABEL}`]);
  assert.ok(calls.indexOf(edit) < calls.indexOf(del), 'banner clears before label removal wakes readiness');
});

test('clean on a PR without the label or banner writes nothing', () => {
  const { calls, gh } = fakeGh({ body: 'Plain', labels: [{ name: 'bug' }] });
  assert.deepEqual(run({ action: 'clean', pr: 7, repo: 'o/r', gh, log: () => {} }), { label: 'unchanged', banner: 'unchanged' });
  assert.equal(apiCalls(calls).length, 0);
  assert.equal(edits(calls).length, 0);
  assert.equal(bannerBody(null, 'clean'), '');
  assert.equal(bannerBody(`x ${BANNER_START} unterminated`, 'clean'), `x ${BANNER_START} unterminated`);
});

test('bannerBody replaces open with blocked and removes repeated banners on clean', () => {
  const opened = bannerBody('Body\n\nmore', 'open');
  const blocked = bannerBody(opened, 'blocked');
  assert.equal(blocked.split(BANNER_START).length, 2, 'one banner only');
  assert.match(blocked, /scored 5 or more/);
  assert.doesNotMatch(blocked, /Review open/);
  assert.equal(bannerBody(blocked, 'clean'), 'Body\n\nmore');
  assert.equal(bannerBody(bannerBody(opened, 'open'), 'clean'), 'Body\n\nmore');
});

test('parse requires --pr and refuses unknown actions, flags or bad PR numbers', () => {
  assert.deepEqual(parse(['open', '--pr', '7']), { action: 'open', pr: 7, repo: null });
  assert.deepEqual(parse(['clean', '--pr', '7', '--repo', 'o/r']), { action: 'clean', pr: 7, repo: 'o/r' });
  assert.throws(() => parse(['start', '--pr', '7']), /open, clean or blocked/);
  assert.throws(() => parse(['open', 'clean', '--pr', '7']), /open, clean or blocked/);
  assert.throws(() => parse(['open']), /--pr/);
  assert.throws(() => parse(['open', '--pr', '0']), /--pr/);
  assert.throws(() => parse(['open', '--pr', '7', '--head', 'a'.repeat(40)]), /Unknown option/);
});

test('the command exits 2 with one line on bad arguments', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'pre-pr-review.cjs'), 'open'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^pre-pr-review: --pr takes a pull request number/);
});
