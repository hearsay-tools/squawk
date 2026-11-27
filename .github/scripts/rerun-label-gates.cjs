'use strict';

// Trusted CI control-plane helper: when a maintainer adds a label that approves
// a failed CI gate (`baseline-growth` or `test-budget`), re-run failed jobs on
// the PR head's latest `pull_request_target` CI run. See docs/sdlc/ci.md.
const { setTimeout: delay } = require('node:timers/promises');

const CI_WORKFLOW = 'ci.yml';
const DEFAULT_WAIT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 30 * 1000;
const MAX_JOB_PAGES = 5;

const LABEL_GATES = Object.freeze({
  'baseline-growth': Object.freeze([
    Object.freeze({ job: 'Check baseline growth and test budget', step: 'Reject baseline growth' }),
    Object.freeze({ job: 'Check function complexity', step: 'Reject function complexity growth' }),
  ]),
  'test-budget': Object.freeze([
    Object.freeze({ job: 'Check baseline growth and test budget', step: 'Check the test line budget' }),
  ]),
});

const newestRun = runs => runs.reduce((latest, run) => (!latest || run.id > latest.id ? run : latest), null);

function matchingFailures(jobs, gates) {
  return gates.filter(gate => jobs.some(job =>
    job.name === gate.job
    && job.status === 'completed'
    && job.conclusion === 'failure'
    && (job.steps ?? []).some(step => step.name === gate.step && step.conclusion === 'failure')));
}

function hasPendingGate(jobs, gates) {
  return gates.some(gate => {
    const job = jobs.find(item => item.name === gate.job);
    return !job || job.status !== 'completed';
  });
}

async function listAttemptJobs(github, repo, runId, attempt) {
  const jobs = [];
  for (let page = 1; page <= MAX_JOB_PAGES; page++) {
    const { data } = await github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
      ...repo, run_id: runId, attempt_number: attempt, per_page: 100, page,
    });
    const batch = data?.jobs ?? [];
    jobs.push(...batch);
    if (batch.length < 100 || (Number.isSafeInteger(data?.total_count) && jobs.length >= data.total_count)) break;
  }
  return jobs;
}

async function latestCiRun(github, repo, headSha) {
  const { data } = await github.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
    ...repo, workflow_id: CI_WORKFLOW, event: 'pull_request_target', head_sha: headSha, per_page: 20,
  });
  return newestRun(data?.workflow_runs ?? []);
}

async function readRun(github, repo, runId) {
  const { data } = await github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { ...repo, run_id: runId });
  return data;
}

async function checkPullState(github, repo, pullNumber, label, expectedHead) {
  const { data: pr } = await github.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...repo, pull_number: pullNumber });
  if (pr.state !== 'open') return { skip: { action: 'skip', reason: 'pr-not-open' } };
  if (!(pr.labels ?? []).some(item => item.name === label)) return { skip: { action: 'skip', reason: 'label-removed' } };
  if (expectedHead && pr.head.sha !== expectedHead) return { skip: { action: 'skip', reason: 'head-changed', headSha: pr.head.sha } };
  return { pr };
}

async function triggerRerun(github, repo, run, headSha, matched) {
  try {
    await github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs', { ...repo, run_id: run.id });
    return { action: 'rerun', runId: run.id, attempt: run.run_attempt, headSha, matched };
  } catch (error) {
    if (error?.status !== 403 && error?.status !== 409) throw error;
    const current = await readRun(github, repo, run.id);
    if (current.status !== 'completed' || current.run_attempt > run.run_attempt) {
      return { action: 'skip', reason: 'already-rerunning', runId: run.id, attempt: current.run_attempt };
    }
    throw error;
  }
}

async function inspectCompletedRun({ github, repo, run, headSha, gates }) {
  const latest = await latestCiRun(github, repo, headSha);
  if (!latest || latest.id !== run.id) return { action: 'skip', reason: 'run-superseded', runId: run.id };
  if (run.conclusion === 'success') return { action: 'skip', reason: 'run-already-passed', runId: run.id, attempt: run.run_attempt };
  if (run.conclusion !== 'failure') return { action: 'skip', reason: 'run-not-failed', runId: run.id, attempt: run.run_attempt, conclusion: run.conclusion };
  const jobs = await listAttemptJobs(github, repo, run.id, run.run_attempt);
  const matched = matchingFailures(jobs, gates);
  if (matched.length === 0) return { action: 'skip', reason: 'no-matching-failed-gate', runId: run.id, attempt: run.run_attempt };
  return triggerRerun(github, repo, run, headSha, matched);
}

async function rerunLabelGates({
  github, owner, repo, pullNumber, label,
  waitMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS, now = Date.now, sleep = delay, log = () => {},
}) {
  const gates = LABEL_GATES[label];
  if (!gates) return { action: 'skip', reason: 'unmapped-label', label };
  if (!Number.isSafeInteger(pullNumber) || pullNumber < 1) throw new Error('Invalid PR number');
  const target = { owner, repo };
  const initial = await checkPullState(github, target, pullNumber, label);
  if (initial.skip) return initial.skip;
  const headSha = initial.pr.head.sha;
  let run = await latestCiRun(github, target, headSha);
  if (!run) return { action: 'skip', reason: 'no-ci-run', headSha };
  const deadline = now() + waitMs;
  let failedAttempt = null;
  for (;;) {
    if (run.status === 'completed') return inspectCompletedRun({ github, repo: target, run, headSha, gates });
    if (failedAttempt !== run.run_attempt) {
      const jobs = await listAttemptJobs(github, target, run.id, run.run_attempt);
      const matched = matchingFailures(jobs, gates);
      if (matched.length > 0) {
        failedAttempt = run.run_attempt;
        log(`CI run ${run.id} attempt ${run.run_attempt} is ${run.status} with failed gate(s): ${matched.map(m => m.step).join(', ')}. Waiting for completion.`);
      } else if (!hasPendingGate(jobs, gates)) {
        return { action: 'skip', reason: 'gate-already-passed', runId: run.id, attempt: run.run_attempt };
      } else {
        log(`CI run ${run.id} attempt ${run.run_attempt} is ${run.status}; waiting for label-gated job(s) to finish.`);
      }
    }
    const remaining = deadline - now();
    if (remaining <= 0) return { action: 'skip', reason: 'wait-timeout', runId: run.id, attempt: run.run_attempt };
    await sleep(Math.min(pollMs, remaining));
    const live = await checkPullState(github, target, pullNumber, label, headSha);
    if (live.skip) return live.skip;
    run = await readRun(github, target, run.id);
  }
}

module.exports = {
  CI_WORKFLOW, DEFAULT_WAIT_MS, DEFAULT_POLL_MS, LABEL_GATES,
  matchingFailures, hasPendingGate, rerunLabelGates,
};
