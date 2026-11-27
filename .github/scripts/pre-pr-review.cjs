#!/usr/bin/env node
'use strict';

// Shows an open pre-PR review round on GitHub (hearsay-tools/squawk#4394).
//
//   node .github/scripts/pre-pr-review.cjs <open|clean|blocked> --pr <n> [--repo <owner/name>]
//
// `open` and `blocked` add the `pre-pr-review` PR label and write the matching
// banner at the top of the PR body; `clean` removes both. The label stays across
// pushes until a review round clears it. PR Readiness keeps the card In progress
// and arm-check.mjs refuses to arm while the label is present.

const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');

const REVIEW_LABEL = 'pre-pr-review';
const ACTIONS = { open: 'add', clean: 'remove', blocked: 'add' };
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
    options: { pr: { type: 'string' }, repo: { type: 'string' } } });
  const [action, ...extra] = positionals;
  if (!Object.hasOwn(ACTIONS, action ?? '') || extra.length) throw new Error('pass one action: open, clean or blocked');
  const pr = Number(values.pr);
  if (!Number.isSafeInteger(pr) || pr <= 0) throw new Error('--pr takes a pull request number');
  return { action, pr, repo: values.repo ?? null };
}

// `gh(args, input)` runs the GitHub CLI and returns its stdout.
function run({ action, pr, repo, gh, log }) {
  const fullName = repo ?? gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  const live = JSON.parse(gh(['pr', 'view', String(pr), '--repo', fullName, '--json', 'body,labels']));
  const hasLabel = Array.isArray(live.labels) && live.labels.some(label => label?.name === REVIEW_LABEL);
  const current = String(live.body ?? '');
  const next = bannerBody(current, action);
  const bodyChanged = next !== current;
  let label = 'unchanged';
  let banner = 'unchanged';
  if (ACTIONS[action] === 'add') {
    if (!hasLabel) {
      gh(['api', '-X', 'POST', `repos/${fullName}/issues/${pr}/labels`, '-f', `labels[]=${REVIEW_LABEL}`]);
      label = 'added';
      log(`PR #${pr} label ${REVIEW_LABEL} added.`);
    }
    if (bodyChanged) {
      gh(['pr', 'edit', String(pr), '--repo', fullName, '--body-file', '-'], next);
      banner = 'written';
      log(`PR #${pr} banner written.`);
    }
  } else {
    if (bodyChanged) {
      gh(['pr', 'edit', String(pr), '--repo', fullName, '--body-file', '-'], next);
      banner = 'removed';
      log(`PR #${pr} banner removed.`);
    }
    if (hasLabel) {
      gh(['api', '-X', 'DELETE', `repos/${fullName}/issues/${pr}/labels/${encodeURIComponent(REVIEW_LABEL)}`]);
      label = 'removed';
      log(`PR #${pr} label ${REVIEW_LABEL} removed.`);
    }
  }
  return { label, banner };
}

function ghCli(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, maxBuffer: 16 << 20, stdio: ['pipe', 'pipe', 'pipe'] });
}

if (require.main === module) {
  try {
    run({ ...parse(process.argv.slice(2)), gh: ghCli, log: line => console.log(line) });
  } catch (error) {
    console.error(`pre-pr-review: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
    process.exit(2);
  }
}

module.exports = { REVIEW_LABEL, ACTIONS, BANNER_START, BANNER_END, bannerBody, parse, run };
