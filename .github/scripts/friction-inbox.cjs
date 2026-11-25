'use strict';

// Posts one friction finding to the day's inbox issue (docs/sdlc/friction.md
// § Friction inbox). The first finding of a UTC day creates the issue. When
// two agents create it at once, both post to the lowest number, and every
// post closes the open higher-numbered copies.

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { INBOX } = require('./friction-policy.cjs');

const DESTINATION = new RegExp(String.raw`^\*\*Destination:\*\*\s*(?:${INBOX.destinations.join('|')})\s*$`, 'm');
const ISSUE_BODY = 'Friction findings recorded on this UTC day, one comment each. The friction digest reviews this issue on the next weekday: see docs/sdlc/friction.md § Friction inbox.';
const USAGE = 'Usage: node .github/scripts/friction-inbox.cjs post <finding.md>\n';
// The issue list shows a new issue only seconds after it is created.
const SETTLE = Object.freeze({ reads: 20, delayMs: 1000 });

function inboxTitle(now = new Date()) {
  return `${INBOX.titlePrefix}${now.toISOString().slice(0, 10)}`;
}

// Every copy of the day's inbox, lowest number first. The list lags: an issue
// created a few seconds ago can be missing from it.
function findInbox(gh, title) {
  const issues = JSON.parse(gh(['issue', 'list', '--repo', INBOX.repo, '--label', INBOX.label, '--state', 'all', '--limit', '100', '--json', 'number,title,state']));
  return issues
    .filter(issue => issue.title === title)
    .map(({ number, state }) => ({ number, state }))
    .sort((a, b) => a.number - b.number);
}

function waitForCreated(gh, title, created, sleep) {
  for (let read = 1; ; read++) {
    const copies = findInbox(gh, title);
    if (copies.some(copy => copy.number === created)) return copies;
    if (read === SETTLE.reads) throw new Error(`created ${INBOX.repo}#${created}, but the issue list did not show it after ${SETTLE.reads} reads; rerun the command`);
    sleep(SETTLE.delayMs);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createdNumber(output) {
  const match = /\/issues\/(\d+)\s*$/.exec(output);
  if (!match) throw new Error(`gh issue create printed no issue URL: ${output.trim()}`);
  return Number(match[1]);
}

function post({ bodyFile, gh, now = new Date(), sleep = sleepSync }) {
  const body = fs.readFileSync(bodyFile, 'utf8');
  if (!DESTINATION.test(body)) throw new Error(`${bodyFile} needs a "**Destination:** ${INBOX.destinations.join(' | ')}" line.`);
  const title = inboxTitle(now);
  let copies = findInbox(gh, title);
  if (copies.length === 0) {
    gh(['label', 'create', INBOX.label, '--repo', INBOX.repo, '--force', '--color', 'C5DEF5', '--description', 'Daily friction inbox; the friction digest reviews it.']);
    const created = createdNumber(gh(['issue', 'create', '--repo', INBOX.repo, '--title', title, '--label', INBOX.label, '--body', ISSUE_BODY]));
    copies = waitForCreated(gh, title, created, sleep);
  }
  // A closed copy keeps its findings: the digest reviews inbox issues in any state.
  const [{ number: issue }, ...others] = copies;
  for (const copy of others) {
    if (copy.state === 'OPEN') gh(['issue', 'close', String(copy.number), '--repo', INBOX.repo, '--comment', `Duplicate of ${INBOX.repo}#${issue}.`]);
  }
  const url = gh(['issue', 'comment', String(issue), '--repo', INBOX.repo, '--body-file', bodyFile]).trim();
  return { issue, url };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main(argv, { run = gh, now = new Date(), stdout = text => process.stdout.write(text), stderr = text => process.stderr.write(text) } = {}) {
  const [command, bodyFile, ...rest] = argv;
  if (command !== 'post' || !bodyFile || rest.length > 0) {
    stderr(USAGE);
    return 2;
  }
  try {
    stdout(`${post({ bodyFile, gh: run, now }).url}\n`);
    return 0;
  } catch (error) {
    stderr(`Friction inbox post failed: ${String(error.stderr || error.message).trim()}\n`);
    return 1;
  }
}

module.exports = { inboxTitle, findInbox, post, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
