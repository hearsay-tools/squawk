'use strict';
const HEAD = 'a'.repeat(40), BASE = 'b'.repeat(40);
const VERIFY = 'Unit, build, E2E, and package';
const SIGNAL_PATH = '.github/workflows/review-signal.yml';
function pullFixture(overrides = {}) {
  return { number: 7, node_id: 'PR_7', state: 'open', draft: false, user: { login: 'author' },
    head: { sha: HEAD, ref: 'feature', repo: { full_name: 'o/r' } },
    base: { sha: BASE, ref: 'main', repo: { full_name: 'o/r' } }, ...overrides };
}
const checkRun = (id, name, conclusion, status = 'completed') => ({ id, name, status, conclusion });
// A green, ready PR 7 whose native CI run just completed.
function readinessState(state = {}) {
  const pulls = state.pulls ?? [pullFixture()];
  const run = { id: 20, run_attempt: 1, workflow_id: 3, path: '.github/workflows/ci.yml', event: 'pull_request_target',
    name: 'CI', repository: { id: 1, full_name: 'o/r' }, head_repository: { full_name: 'o/r' }, head_sha: HEAD,
    head_branch: 'feature', status: 'completed', conclusion: 'success',
    pull_requests: pulls.map(p => ({ number: p.number, head: { sha: p.head.sha }, base: { ref: p.base.ref } })) };
  return { run, rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: VERIFY }] } }],
    checkRuns: [checkRun(1, VERIFY, 'success')], statuses: [], threads: [], calls: [], coreRemaining: 5000, ...state, pulls };
}
function livePull(s, number) {
  return s.live?.(number) ?? s.pulls.find(p => p.number === number);
}
function actionsData(s, route, args) {
  if (route.endsWith('/workflows/{workflow_id}')) return { id: 4, path: SIGNAL_PATH, state: 'active' };
  if (route.endsWith('/workflows/{workflow_id}/runs')) return { total_count: 1, workflow_runs: [s.signal] };
  if (route.endsWith('/runs/{run_id}')) return args.run_id === 40 ? s.signal : s.run;
  throw new Error(`Unexpected actions route ${route}`);
}
function readinessData(s, route, args) {
  if (route.endsWith('/pulls/{pull_number}')) return livePull(s, args.pull_number);
  if (route.endsWith('/rules/branches/{branch}')) return s.rules;
  if (route.endsWith('/commits/{ref}/status')) return { statuses: s.statuses };
  if (route.endsWith('/commits/{ref}/check-runs')) return { total_count: s.checkRuns.length, check_runs: s.checkRuns };
  if (route.includes('/actions/')) return actionsData(s, route, args);
  if (route === 'POST /graphql') return { data: { repository: { pullRequest: { reviewThreads: {
    nodes: s.threads, pageInfo: { hasNextPage: false, endCursor: null } } } } } };
  if (route === 'GET /rate_limit') return { resources: { core: { remaining: s.coreRemaining, reset: 1 } } };
  throw new Error(`Unexpected route ${route}`);
}
// A GitHub client double: every call is recorded, and each read answers from `state`.
function fakeGithub(state = {}) {
  const s = readinessState(state);
  return { state: s, calls: s.calls, request: async (route, args = {}) => {
    s.calls.push([route, args]); s.onRead?.(route, args);
    if (s.fail?.(route, args)) throw new Error('API unavailable');
    return { data: structuredClone(readinessData(s, route, args)) };
  } };
}
function signalRun(overrides = {}) {
  return { id: 40, name: 'Review signal', run_attempt: 1, workflow_id: 4, path: SIGNAL_PATH,
    event: 'pull_request_review_comment', head_sha: BASE, status: 'completed', conclusion: 'success',
    repository: { id: 1, full_name: 'o/r' }, head_repository: { full_name: 'o/r' },
    pull_requests: [{ number: 7, head: { sha: HEAD, repo: { id: 1 } }, base: { ref: 'main', repo: { id: 1 } } }], ...overrides };
}
module.exports = { fakeGithub, readinessData, readinessState, pullFixture, checkRun, signalRun, HEAD, BASE, VERIFY };
