// Read-only diagnosis of a PR's native CI run for the recovery cases a failed-jobs
// rerun cannot fix: an abandoned job, a startup failure and a job stuck in the queue.
// It runs on the agent's host, so it still works while GitHub Actions is degraded.
// See docs/sdlc/ci.md § Re-running a failed job.
const {execFileSync} = require('node:child_process');
const {parseArgs: nodeParseArgs} = require('node:util');

const QUEUED_BOUND_MS = 15 * 60 * 1000;
const PEER_WINDOW_MS = 2 * 60 * 60 * 1000;
const ABANDONED = /was never created \(abandoned\)/;
const GATES = new Set(['Review preflight', 'Unit, build, E2E, and package']);

function parseArgs(argv) {
  const {values} = nodeParseArgs({args: argv, options: {pr: {type: 'string'}, repo: {type: 'string'}, help: {type: 'boolean'}}});
  if (values.help) return {help: true};
  if (!/^\d+$/.test(values.pr ?? '')) throw new Error('Supply --pr <number>');
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) throw new Error('--repo must be OWNER/REPO');
  return {pr: Number(values.pr), repo: values.repo ?? 'hearsay-tools/squawk'};
}

const ageMs = (timestamp, now) => now - Date.parse(timestamp);
const minutes = ms => Math.floor(ms / 60_000);

function latestRun(runs) {
  return [...runs].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
}

function stuckJobs(run, jobs, now) {
  const queued = jobs.filter(job => job.status === 'queued' && ageMs(job.created_at, now) > QUEUED_BOUND_MS);
  if (queued.length || jobs.length || run.status !== 'queued' || ageMs(run.created_at, now) <= QUEUED_BOUND_MS) return queued;
  return [{name: 'The whole run', created_at: run.created_at}];
}

function peerStartup(peers, headSha) {
  const others = peers.filter(run => run.head_sha !== headSha && run.status === 'completed');
  return {failed: others.filter(run => run.conclusion === 'startup_failure').length, total: others.length};
}

function abandonedNeeds(gateJobs, annotationsOf) {
  return gateJobs.flatMap(job => annotationsOf(job).filter(note => ABANDONED.test(note.message)).map(note => note.message.split(' was never created')[0]));
}

function diagnose(options, {request, now = Date.now()}) {
  const pr = request(`/repos/${options.repo}/pulls/${options.pr}`);
  const runs = request(`/repos/${options.repo}/actions/workflows/ci.yml/runs?event=pull_request_target&head_sha=${pr.head.sha}&per_page=20`).workflow_runs;
  const run = latestRun(runs);
  const base = {repo: options.repo, pr: options.pr, headSha: pr.head.sha};
  if (!run) return {...base, kind: 'no-run'};
  const at = {...base, runId: run.id, attempt: run.run_attempt};
  if (run.conclusion === 'startup_failure') {
    const since = new Date(now - PEER_WINDOW_MS).toISOString().replace(/\.\d+Z$/, 'Z');
    const peers = request(`/repos/${options.repo}/actions/runs?event=pull_request_target&created=%3E%3D${since}&per_page=100`).workflow_runs;
    return {...at, kind: 'startup-failure', peers: peerStartup(peers, pr.head.sha)};
  }
  const jobs = request(`/repos/${options.repo}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`).jobs;
  const stuck = stuckJobs(run, jobs, now);
  if (stuck.length) return {...at, kind: 'queued', jobs: stuck.map(job => ({name: job.name, minutes: minutes(ageMs(job.created_at, now))}))};
  // Both gates run with `if: always()`, so a completed run without one never created it.
  const absent = run.status === 'completed' ? [...GATES].filter(name => !jobs.some(job => job.name === name)) : [];
  const gates = jobs.filter(job => GATES.has(job.name) && job.conclusion === 'failure');
  const needs = [...absent, ...abandonedNeeds(gates, job => request(`/repos/${options.repo}/check-runs/${job.id}/annotations`))];
  if (needs.length) return {...at, kind: 'abandoned', needs: [...new Set(needs)]};
  return {...at, kind: 'other', status: run.status, conclusion: run.conclusion};
}

function reopen({pr, repo}) {
  return `gh pr close ${pr} --repo ${repo} && gh pr reopen ${pr} --repo ${repo}`;
}

const NOTICES = {
  'no-run': d => [`PR #${d.pr} head ${d.headSha} has no native CI run.`,
    `Recovery: close and reopen the PR to start one: ${reopen(d)}`],
  abandoned: d => [`Run ${d.runId} attempt ${d.attempt}: ${d.needs.join(', ')} was never created (abandoned). "Re-run failed jobs" cannot recreate it.`,
    `Recovery: a full rerun, without --failed: gh run rerun ${d.runId} --repo ${d.repo}. If that attempt fails the same way, push a new head.`],
  queued: d => [`Run ${d.runId} attempt ${d.attempt}: ${d.jobs.map(job => `${job.name} (queued ${job.minutes} min)`).join(', ')}. A job normally starts within seconds; the bound is ${minutes(QUEUED_BOUND_MS)} min. GitHub cannot retry a run that ends with queued jobs.`,
    `Recovery: close and reopen the PR for a fresh native run on the same head: ${reopen(d)}. Push a new head only if the new run also stays queued. Do not push an empty commit.`],
  'startup-failure': startupNotice,
  other: d => [`Run ${d.runId} attempt ${d.attempt} is ${d.conclusion ?? d.status}: no abandoned, startup-failed or stuck-queued job.`,
    d.status === 'completed' ? `Recovery: read the failing job's log. A flaky failure uses Re-run failed jobs: gh run rerun ${d.runId} --failed --repo ${d.repo}` : 'Wait for the run to complete.'],
};

function startupFailureCause({failed, total}) {
  if (failed > 0) return `${failed} of ${total} other PR runs in the last ${minutes(PEER_WINDOW_MS) / 60} h also ended startup_failure: the cause is GitHub-side. Do not change the PR. Wait until another PR's run starts, then close and reopen this PR`;
  if (total > 0) return `None of ${total} other PR runs in the last ${minutes(PEER_WINDOW_MS) / 60} h ended startup_failure: the cause is in this PR or a repository setting. Compare with the last PR run that started, then close and reopen this PR`;
  return `No other PR ran in the last ${minutes(PEER_WINDOW_MS) / 60} h, so the cause is unknown. Close and reopen this PR once`;
}

function startupNotice(d) {
  return [`Run ${d.runId} ended startup_failure with 0 jobs. GitHub cannot re-run it.`,
    `${startupFailureCause(d.peers)}: ${reopen(d)}`];
}

const recoveryNotice = diagnosis => NOTICES[diagnosis.kind](diagnosis).join('\n');

function ghRequest(endpoint) {
  return JSON.parse(execFileSync('gh', ['api', endpoint], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
}

function main(argv, {request = ghRequest, out = console.log, err = console.error} = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) { out('Usage: node .github/scripts/ci-recovery.cjs --pr <number> [--repo OWNER/REPO]'); return 0; }
    out(recoveryNotice(diagnose(options, {request})));
    return 0;
  } catch (error) {
    err(`ci-recovery: ${error.message}`);
    return 1;
  }
}

module.exports = {QUEUED_BOUND_MS, PEER_WINDOW_MS, parseArgs, diagnose, recoveryNotice, main};
if (require.main === module) process.exitCode = main(process.argv.slice(2));
