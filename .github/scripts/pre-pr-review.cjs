#!/usr/bin/env node
'use strict';

// Shows an open pre-PR review round on GitHub (hearsay-tools/squawk#4191).
//
//   node .github/scripts/pre-pr-review.cjs <open|clean|blocked> --head <sha> [--pr <n>] [--repo <owner/name>]
//
// Sets the `pre-pr-review` commit status on the reviewed head: `open` -> pending,
// `clean` -> success, `blocked` -> failure (a finding scored 5 or more is open).
// GitHub accepts a status only on a pushed commit, so push first. With --pr, and
// when the PR's live head is the reviewed head, it also writes the banner at the
// top of the PR body: `open` and `blocked` write it, `clean` removes it.
// PR Readiness keeps the card In progress and arm-check.mjs refuses to arm while
// the status is pending or failure. The status is not a required check.

const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const REVIEW_CONTEXT = 'pre-pr-review';
const STATES = { open: 'pending', clean: 'success', blocked: 'failure' };
const DESCRIPTIONS = {
  open: 'Review round open',
  clean: 'Review round clean',
  blocked: 'Review found a finding scored 5 or more',
};
const BANNER_START = '<!-- pre-pr-review:start -->';
const BANNER_END = '<!-- pre-pr-review:end -->';
const BANNERS = {
  open: '> [!WARNING]\n> ⏳ **Review open.** A pre-PR review round runs on this head. Do not queue this PR until the round is clean.',
  blocked: '> [!CAUTION]\n> ⛔ **Review found a finding scored 5 or more.** Do not queue this PR until a fix passes its round.',
};

// The body without any banner block, then the new banner for `action` on top.
function bannerBody(body, action) {
  let rest = String(body ?? '');
  for (;;) {
    const start = rest.indexOf(BANNER_START);
    const end = start < 0 ? -1 : rest.indexOf(BANNER_END, start);
    if (end < 0) break;
    rest = rest.slice(0, start) + rest.slice(end + BANNER_END.length).replace(/^\n+/, '');
  }
  const banner = BANNERS[action];
  return banner ? `${BANNER_START}\n${banner}\n${BANNER_END}\n\n${rest}` : rest;
}

function parse(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true,
    options: { head: { type: 'string' }, pr: { type: 'string' }, repo: { type: 'string' } } });
  const [action, ...extra] = positionals;
  if (!Object.hasOwn(STATES, action ?? '') || extra.length) throw new Error('pass one action: open, clean or blocked');
  if (!/^[0-9a-f]{40}$/.test(values.head ?? '')) throw new Error('pass --head <the reviewed 40-character sha>');
  const pr = values.pr === undefined ? null : Number(values.pr);
  if (pr !== null && (!Number.isSafeInteger(pr) || pr <= 0)) throw new Error('--pr takes a pull request number');
  return { action, head: values.head, pr, repo: values.repo ?? null };
}

function description(action, taskId) {
  const task = /^[0-9a-f-]{8,}$/i.test(taskId ?? '') ? ` (task ${taskId.slice(0, 8)})` : '';
  return `${DESCRIPTIONS[action]}${task}`;
}

// `gh(args, input)` runs the GitHub CLI and returns its stdout.
function run({ action, head, pr, repo, taskId, gh, log }) {
  const fullName = repo ?? gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  gh(['api', '-X', 'POST', `repos/${fullName}/statuses/${head}`, '-f', `state=${STATES[action]}`,
    '-f', `context=${REVIEW_CONTEXT}`, '-f', `description=${description(action, taskId)}`]);
  log(`${REVIEW_CONTEXT} is ${STATES[action]} on ${head}.`);
  if (pr === null) return { status: STATES[action], banner: 'skipped' };
  const live = JSON.parse(gh(['pr', 'view', String(pr), '--repo', fullName, '--json', 'body,headRefOid']));
  if (live.headRefOid !== head) {
    log(`PR #${pr} head is ${live.headRefOid}, not ${head}: the banner is unchanged.`);
    return { status: STATES[action], banner: 'other-head' };
  }
  const next = bannerBody(live.body, action);
  if (next === live.body) return { status: STATES[action], banner: 'unchanged' };
  gh(['pr', 'edit', String(pr), '--repo', fullName, '--body-file', '-'], next);
  log(`PR #${pr} banner ${BANNERS[action] ? 'written' : 'removed'}.`);
  return { status: STATES[action], banner: BANNERS[action] ? 'written' : 'removed' };
}

function ghCli(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 16 << 20, stdio: ['pipe', 'pipe', 'pipe'] });
}

if (require.main === module) {
  try {
    const taskId = process.env.HSQ_TASK_ID || process.env.CEZ_TASK_ID;
    run({ ...parse(process.argv.slice(2)), taskId, gh: ghCli, log: line => console.log(line) });
  } catch (error) {
    console.error(`pre-pr-review: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    process.exit(2);
  }
}

module.exports = { REVIEW_CONTEXT, STATES, BANNER_START, BANNER_END, bannerBody, parse, description, run };
