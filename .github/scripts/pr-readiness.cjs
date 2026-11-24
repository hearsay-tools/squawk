'use strict';

// The board follows the head (hearsay-tools/cezarion#603, hearsay-tools/cezarion#3288).
// Trusted control plane of PR Readiness (pr-readiness.yml): one job per PR reads
// the live head once and syncs the board. It never checks out PR code, writes to
// the repository or changes draft state: agents open pull requests ready, and a
// human's draft stays a draft.
//   - The PR's and its closing issues' cards move to In review once the PR is
//     ready, every required check on the live head passes and no thread is open.
//   - Any other state moves them to In progress: a new head, a pending or red
//     check, an open thread, a draft, or an open pre-PR review round (the
//     `pre-pr-review` commit status is pending or failure; pre-pr-review.cjs).
// Human draft/ready flips arrive as their own events and resync the board.

const { reader, pages, positive, validSha, VERIFY } = require('./queue-ci-proof.cjs');
const { listReviewThreads } = require('./review-threads.cjs');
const { signalTarget } = require('./review-signal.cjs');
const { DEFAULT_FLOOR, countApiCalls, checkFloor } = require('./api-budget.cjs');
const { REVIEW_CONTEXT } = require('./pre-pr-review.cjs');

const PASSING = new Set(['success', 'skipped', 'neutral']);
const BOARD = { progress: 'In progress', review: 'In review' };
const DONE_STATUS = 'done';

// `read` is the deadline-bound reader from queue-ci-proof.cjs.
async function requiredCheckNames(read, branch) {
  const rules = await read('GET /repos/{owner}/{repo}/rules/branches/{branch}', { branch, per_page: 100 });
  if (!Array.isArray(rules)) throw new Error('Could not read the branch rules.');
  const names = new Set();
  for (const rule of rules) {
    if (rule?.type !== 'required_status_checks') continue;
    for (const check of rule.parameters?.required_status_checks || []) {
      if (typeof check?.context === 'string' && check.context) names.add(check.context);
    }
  }
  return [...names].sort();
}

// A re-run adds a newer check run with the same name; only the latest counts.
function latestByName(checkRuns) {
  const latest = new Map();
  for (const run of checkRuns || []) {
    if (typeof run?.name !== 'string' || !Number.isSafeInteger(run.id)) continue;
    if (!latest.has(run.name) || latest.get(run.name).id < run.id) latest.set(run.name, run);
  }
  return latest;
}

function evaluateChecks({ required, checkRuns, statuses = [] }) {
  const runs = latestByName(checkRuns);
  const states = new Map();
  for (const status of statuses) {
    if (typeof status?.context === 'string' && !states.has(status.context)) states.set(status.context, status.state);
  }
  const result = { ready: true, pending: [], failing: [], missing: [] };
  for (const name of required) {
    const run = runs.get(name);
    if (run) {
      if (run.status !== 'completed') result.pending.push(name);
      else if (!(name === VERIFY ? run.conclusion === 'success' : PASSING.has(run.conclusion))) result.failing.push(name);
      continue;
    }
    const state = states.get(name);
    if (state === 'success') continue;
    if (state === 'pending') result.pending.push(name);
    else if (state) result.failing.push(name);
    else result.missing.push(name);
  }
  // The review round is not a required check: absent or success leaves readiness
  // to the required checks, pending or failure holds it.
  const review = required.includes(REVIEW_CONTEXT) ? undefined : states.get(REVIEW_CONTEXT);
  if (review === 'pending') result.pending.push(REVIEW_CONTEXT);
  else if (review === 'failure' || review === 'error') result.failing.push(REVIEW_CONTEXT);
  result.ready = !result.pending.length && !result.failing.length && !result.missing.length;
  return result;
}

// Three reads: the branch rules, the head's check runs and its commit statuses.
async function readHeadChecks(read, sha) {
  const required = await requiredCheckNames(read, 'main');
  const checkRuns = await pages(read, 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs', { ref: sha }, 'check_runs');
  const combined = await read('GET /repos/{owner}/{repo}/commits/{ref}/status', { ref: sha, per_page: 100 });
  return evaluateChecks({ required, checkRuns, statuses: combined?.statuses || [] });
}

const BOARD_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      projectItems(first: 20) { nodes { ...item } }
      closingIssuesReferences(first: 20) { nodes { projectItems(first: 20) { nodes { ...item } } } }
    }
  }
}
fragment item on ProjectV2Item {
  id
  project { id field(name: "Status") { ... on ProjectV2SingleSelectField { id options { id name } } } }
  fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
}`;

function projectItems(pull) {
  return [
    ...(pull?.projectItems?.nodes || []),
    ...(pull?.closingIssuesReferences?.nodes || []).flatMap((issue) => issue?.projectItems?.nodes || []),
  ];
}

function statusOption(field, status) {
  return field?.options?.find((candidate) => candidate?.name?.toLowerCase() === status.toLowerCase());
}

// One card's move, or null when the card must stay where it is.
function cardMove(item, status) {
  const option = statusOption(item?.project?.field, status);
  const current = item?.fieldValueByName?.name?.toLowerCase() || null;
  if (!item?.id || !option || current === DONE_STATUS || current === status.toLowerCase()) return null;
  return { projectId: item.project.id, itemId: item.id, fieldId: item.project.field.id, optionId: option.id };
}

// Every card the PR or its closing issues have, on any board with a Status
// field that names the target option. Done cards never move back.
function boardMoves(data, status) {
  const moves = [];
  const seen = new Set();
  for (const item of projectItems(data?.repository?.pullRequest)) {
    const move = cardMove(item, status);
    if (!move || seen.has(move.itemId)) continue;
    seen.add(move.itemId);
    moves.push(move);
  }
  return moves;
}

// Board access is optional: without a project-capable token the sync reports
// why and returns.
// The project requests share one budget, apart from the 120-second read deadline.
const BOARD_BUDGET_MS = 15000;
// Ends when the request ends or the budget aborts it, even for a client that
// ignores the signal. A late result after the abort is dropped.
function bounded(request, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('board request budget exhausted'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function syncBoard({ projectGithub, owner, repo, pullNumber, status, log,
  signal = AbortSignal.timeout(BOARD_BUDGET_MS) }) {
  if (!projectGithub) {
    log(`Board sync skipped for #${pullNumber}: no project token (grant the release App Organization projects access).`);
    return { moved: 0, skipped: 'no-token' };
  }
  const graphql = (query, variables) => bounded(Promise.resolve()
    .then(() => projectGithub.graphql(query, { ...variables, request: { signal, retries: 0 } })), signal);
  try {
    const data = await graphql(BOARD_QUERY, { owner, repo, number: pullNumber });
    const moves = boardMoves(data, status);
    for (const move of moves) {
      await graphql(`mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) { projectV2Item { id } }
      }`, move);
    }
    log(`Board sync for #${pullNumber}: moved ${moves.length} card(s) to ${status}.`);
    return { moved: moves.length };
  } catch (error) {
    log(`Board sync skipped for #${pullNumber}: ${error.message}`);
    return { moved: 0, skipped: 'error' };
  }
}

// One board decision: In review only when the PR is ready, every required
// check on the live head passes and no review thread is open.
function boardStatus({ checks, resolved, draft }) {
  return checks?.ready && resolved && !draft ? BOARD.review : BOARD.progress;
}

const TARGET_LIMIT = 4;
const PULL_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review', 'converted_to_draft']);
const recovery = reason => new Error(`${reason}; dispatch with pr_number for manual recovery`);
function associationNumbers(pulls) {
  if (!Array.isArray(pulls) || pulls.length > TARGET_LIMIT
    || pulls.some(pr => !positive(pr?.number) || !validSha(pr.head?.sha) || typeof pr.base?.ref !== 'string')) {
    throw recovery('Malformed or oversized PR association');
  }
  return [...new Set(pulls.map(pr => pr.number))];
}
async function workflowTarget(read, payload, fullName) {
  const source = payload.workflow_run;
  if (payload.action !== 'completed' || source?.name !== 'CI' || source.event !== 'pull_request_target'
    || !positive(source.id) || !positive(source.run_attempt)) return [];
  const run = await read('GET /repos/{owner}/{repo}/actions/runs/{run_id}', { run_id: source.id });
  if (run.id !== source.id || run.run_attempt !== source.run_attempt || run.status !== 'completed'
    || run.event !== 'pull_request_target' || run.path !== '.github/workflows/ci.yml'
    || run.repository?.full_name !== fullName || run.head_sha !== source.head_sha) return [];
  const numbers = associationNumbers(run.pull_requests);
  if (!numbers.length) throw recovery('Missing native CI PR association');
  return numbers;
}
// A `pre-pr-review` status names a head; its open PRs are the targets. Any other
// status context selects nothing and reads nothing.
async function statusTarget(read, payload) {
  if (payload.context !== REVIEW_CONTEXT || !validSha(payload.sha)) return [];
  const pulls = await read('GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls', { commit_sha: payload.sha, per_page: 100 });
  if (!Array.isArray(pulls)) throw recovery('Malformed commit PR association');
  return associationNumbers(pulls.filter(pr => pr?.state === 'open' && pr.head?.sha === payload.sha));
}
// The PR numbers an event names. The event is only a wake hint: each job reads
// the live PR itself.
async function eventTarget(read, eventName, payload, fullName) {
  if (payload.repository?.full_name !== fullName) throw new Error('Foreign event');
  if (eventName === 'workflow_dispatch') {
    const number = Number(payload.inputs?.pr_number);
    if (!positive(number)) throw new Error('pr_number must be a positive integer');
    return [number];
  }
  if (eventName === 'pull_request_target') {
    const number = payload.pull_request?.number;
    return PULL_ACTIONS.has(payload.action) && positive(number) ? [number] : [];
  }
  if (eventName === 'status') return statusTarget(read, payload);
  if (eventName !== 'workflow_run') return [];
  if (payload.workflow_run?.name !== 'Review signal') return workflowTarget(read, payload, fullName);
  const signal = await signalTarget(read, payload, fullName);
  return signal ? [signal.number] : [];
}
// Fork PRs get no board sync.
function eligiblePull(pr, fullName) {
  return positive(pr?.number) && pr.state === 'open' && validSha(pr.head?.sha)
    && typeof pr.head.ref === 'string' && pr.head.repo?.full_name === fullName
    && pr.base?.ref === 'main' && pr.base.repo?.full_name === fullName;
}
async function discover({ github, owner, repo, eventName, payload, now = Date.now, log = () => {} }) {
  const fullName = `${owner}/${repo}`, read = reader(github, owner, repo, now() + 120000, now);
  const numbers = [];
  for (const number of await eventTarget(read, eventName, payload, fullName)) {
    const pr = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: number });
    if (pr?.number === number && eligiblePull(pr, fullName)) numbers.push(number);
    else log('Skipped a changed or ineligible PR.');
  }
  return { numbers };
}

// Under the core floor of the token that serves the reads, the sync skips and a
// later event catches up. GET /rate_limit is free.
const FLOOR_READ_MS = 5000;
async function withinBudget({ github, pr, floor, log }) {
  const budget = { request: route => github.request(route,
    { request: { timeout: FLOOR_READ_MS, signal: AbortSignal.timeout(FLOOR_READ_MS), retries: 0 } }) };
  const { proceed, remaining } = await checkFloor({ github: budget, floor });
  if (!proceed) log(`PR ${pr.number}: board sync skipped: core remaining ${remaining} on the read token is under the floor of ${floor}; a later event catches up.`);
  return proceed;
}
// Threads are read only when they can decide the status. An unread answer
// counts as an open thread.
async function threadsResolved(read, owner, repo, pr, log) {
  const graphql = async (query, variables) => {
    const result = await read('POST /graphql', { query, variables });
    if (result?.errors) throw new Error('Incomplete GraphQL response');
    return result?.data;
  };
  try {
    return (await listReviewThreads({ github: { graphql }, owner, repo, pullNumber: pr.number })).every(thread => thread.isResolved);
  } catch {
    log(`PR ${pr.number}: review threads unavailable.`);
    return false;
  }
}
function sameLivePull(live, pr, fullName) {
  return live?.state === 'open' && live.head?.sha === pr.head.sha && live.base?.ref === 'main'
    && live.head.repo?.full_name === fullName && live.base.repo?.full_name === fullName;
}
// `github` makes every read (the release App when available); `projectGithub`
// syncs the board. A final PR read refuses a stale move when the head, state
// or target changed while this job read.
async function syncPull({ github, projectGithub = null, owner, repo, pullNumber, boardFloor = DEFAULT_FLOOR, now = Date.now, log = () => {} }) {
  if (!positive(pullNumber)) throw new Error('Missing trusted discovery PR number');
  if (!projectGithub) return (await syncBoard({ projectGithub, owner, repo, pullNumber, log })).skipped;
  const fullName = `${owner}/${repo}`, read = reader(github, owner, repo, now() + 120000, now);
  const pr = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pullNumber });
  if (pr?.number !== pullNumber || !eligiblePull(pr, fullName)) return 'ineligible';
  if (!(await withinBudget({ github, pr, floor: boardFloor, log }))) return 'under-floor';
  let checks;
  try { checks = await readHeadChecks(read, pr.head.sha); }
  catch {
    log(`PR ${pr.number}: required checks unavailable; board sync skipped.`);
    return 'checks-unavailable';
  }
  const resolved = checks.ready && !pr.draft && await threadsResolved(read, owner, repo, pr, log);
  let final;
  try { final = await read('GET /repos/{owner}/{repo}/pulls/{pull_number}', { pull_number: pr.number }); }
  catch {
    log(`PR ${pr.number}: board sync skipped: the final PR read failed.`);
    return 'pull-unavailable';
  }
  if (!sameLivePull(final, pr, fullName)) return 'changed';
  const status = boardStatus({ checks, resolved, draft: final.draft });
  log(`PR ${final.number}: board follows ${status} (checks=${checks.ready}, threads resolved=${resolved}, draft=${final.draft}).`);
  await syncBoard({ projectGithub, owner, repo, pullNumber: pr.number, status, log });
  return status;
}
// Each token has its own quota, so each distinct client gets one count line.
// A client that serves several roles keeps its first label.
function countTokens(tokens) {
  const counted = new Map();
  for (const [label, client] of tokens) if (client && !counted.has(client)) counted.set(client, [label, countApiCalls(client)]);
  return () => [...counted.values()].map(([label, calls]) => `${label}: ${calls.summary()}`);
}

module.exports = {
  BOARD,
  requiredCheckNames,
  latestByName,
  evaluateChecks,
  readHeadChecks,
  boardMoves,
  boardStatus,
  syncBoard,
  BOARD_BUDGET_MS,
  discover,
  syncPull,
  countTokens,
  eventTarget,
  eligiblePull,
};
