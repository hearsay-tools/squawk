const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { BOARD, requiredCheckNames, evaluateChecks, boardMoves, syncBoard, discover, syncPull } = require('./pr-readiness.cjs');
const { reader } = require('./queue-ci-proof.cjs');
const { fakeGithub, pullFixture, checkRun, signalRun, HEAD: sha, VERIFY } = require('./pr-readiness.testkit.cjs');
const workflowPath = path.join(__dirname, '..', 'workflows', 'pr-readiness.yml');
const owner = 'o';
const repo = 'r';
const FREE = 'GET /rate_limit';
const PULL = 'GET /repos/{owner}/{repo}/pulls/{pull_number}';
const THREADS = 'POST /graphql';

const workflowRun = (github, overrides = {}) => ({ action: 'completed', workflow_run: { ...github.state.run, ...overrides } });
function eventArgs(args) {
  return { ...args, owner, repo, payload: { repository: { full_name: 'o/r' }, ...args.payload } };
}
async function handleEvent(args) {
  const input = eventArgs(args);
  const { numbers } = await discover(input);
  return Promise.all(numbers.map(pullNumber => syncPull({ ...input, pullNumber })));
}
async function completeRun(github, extra = {}) {
  const logs = [];
  await handleEvent({ github, eventName: 'workflow_run', payload: workflowRun(github), log: (m) => logs.push(m), ...extra });
  return logs;
}

function boardItem(id, current, projectId = 'P1') {
  return {
    id,
    project: { id: projectId, field: { id: 'F1', options: [
      { id: 'opt-progress', name: 'In progress' }, { id: 'opt-review', name: 'In review' }, { id: 'opt-done', name: 'Done' },
    ] } },
    fieldValueByName: current === null ? null : { name: current },
  };
}

function boardData({ pullItems = [], issueItems = [] }) {
  return { repository: { pullRequest: {
    projectItems: { nodes: pullItems },
    closingIssuesReferences: { nodes: [{ projectItems: { nodes: issueItems } }] },
  } } };
}

function fakeBoard({ current = null, data = null, fail = false } = {}) {
  const board = { moves: [], numbers: [], data: data ?? boardData({ pullItems: [boardItem('PR_ITEM', current)], issueItems: [boardItem('ISSUE_ITEM', current)] }) };
  board.graphql = async (query, variables) => {
    if (fail) throw new Error('Resource not accessible by integration');
    if (query.includes('updateProjectV2ItemFieldValue')) {
      board.moves.push(variables);
      const pull = board.data.repository.pullRequest;
      const items = [...pull.projectItems.nodes, ...pull.closingIssuesReferences.nodes.flatMap(issue => issue.projectItems.nodes)];
      for (const item of items.filter(item => item.id === variables.itemId)) {
        item.fieldValueByName = { name: item.project.field.options.find(option => option.id === variables.optionId).name };
      }
      return {};
    }
    board.numbers.push(variables.number);
    return structuredClone(board.data);
  };
  return board;
}

// The status of the PR card and the closing issue card, in that order.
function cards(board) {
  const pull = board.data.repository.pullRequest;
  return [pull.projectItems.nodes[0], pull.closingIssuesReferences.nodes[0].projectItems.nodes[0]]
    .map(item => item.fieldValueByName?.name ?? null);
}
const IN_REVIEW = ['In review', 'In review'];
const IN_PROGRESS = ['In progress', 'In progress'];
const routes = github => github.calls.map(([route]) => route);

test('requires exactly the checks the ruleset names', async () => {
  const github = fakeGithub({ rules: [
    { type: 'pull_request', parameters: {} },
    { type: 'required_status_checks', parameters: { required_status_checks: [{ context: VERIFY }, { context: 'lint' }, { context: '' }, {}] } },
  ] });
  const read = client => reader(client, owner, repo, Date.now() + 60000, Date.now);
  assert.deepEqual(await requiredCheckNames(read(github), 'main'), [VERIFY, 'lint'].sort());
  await assert.rejects(requiredCheckNames(read(fakeGithub({ rules: { message: 'not a list' } })), 'main'), /branch rules/);
});

test('evaluates the latest run per required check, and commit statuses as a fallback', () => {
  const required = [VERIFY, 'lint', 'legacy/status'];
  assert.deepEqual(evaluateChecks({
    required,
    checkRuns: [checkRun(1, VERIFY, 'failure'), checkRun(5, VERIFY, 'success'), checkRun(2, 'lint', 'skipped')],
    statuses: [{ context: 'legacy/status', state: 'success' }],
  }), { ready: true, pending: [], failing: [], missing: [] });
  assert.deepEqual(evaluateChecks({
    required,
    checkRuns: [checkRun(9, VERIFY, 'failure'), checkRun(5, VERIFY, 'success'), checkRun(2, 'lint', null, 'in_progress')],
    statuses: [],
  }), { ready: false, pending: ['lint'], failing: [VERIFY], missing: ['legacy/status'] });
  for (const conclusion of ['skipped', 'neutral', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure', null]) {
    assert.equal(evaluateChecks({ required: [VERIFY], checkRuns: [checkRun(1, VERIFY, conclusion)] }).ready, false, String(conclusion));
  }
  assert.deepEqual(evaluateChecks({ required: ['s'], checkRuns: [], statuses: [{ context: 's', state: 'pending' }] }).pending, ['s']);
  assert.deepEqual(evaluateChecks({ required: ['s'], checkRuns: [], statuses: [{ context: 's', state: 'error' }] }).failing, ['s']);
});

test('a ready PR whose head checks are green moves its linked cards to In review', async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  const logs = await completeRun(github, { projectGithub: board });
  assert.deepEqual(board.moves.map(({ itemId, optionId }) => [itemId, optionId]), [['PR_ITEM', 'opt-review'], ['ISSUE_ITEM', 'opt-review']]);
  assert.ok(github.calls.some(([route, params]) => route.endsWith('/commits/{ref}/check-runs') && params.ref === sha),
    'checks are read for the live head, not a branch');
  assert.match(logs.join('\n'), /PR 7: board follows In review \(checks=true, threads resolved=true, draft=false\)/);
});

test('a red, pending or missing required check moves the cards to In progress without a thread read', async () => {
  for (const checkRuns of [
    [checkRun(1, VERIFY, 'failure')],
    [checkRun(1, VERIFY, 'skipped')],
    [checkRun(1, VERIFY, null, 'in_progress')],
    [],
  ]) {
    const github = fakeGithub({ checkRuns });
    const board = fakeBoard({ current: 'In review' });
    const logs = await completeRun(github, { projectGithub: board });
    assert.deepEqual(cards(board), IN_PROGRESS, JSON.stringify(checkRuns));
    assert.match(logs.join('\n'), /board follows In progress \(checks=false, threads resolved=false, draft=false\)/);
    assert.equal(routes(github).includes(THREADS), false, 'threads cannot change the status');
  }
});

test('an unresolved review thread of any author, outdated or not, moves the cards to In progress', async () => {
  for (const thread of [{ id: 'T1', isResolved: false }, { id: 'T1', isResolved: false, isOutdated: true }]) {
    const github = fakeGithub({ threads: [{ id: 'T0', isResolved: true }, thread] });
    const board = fakeBoard({ current: 'In review' });
    await completeRun(github, { projectGithub: board });
    assert.deepEqual(cards(board), IN_PROGRESS, JSON.stringify(thread));
  }
});

test('unreadable or malformed review threads count as open', async () => {
  for (const state of [{ fail: route => route === THREADS }, { threads: [{ id: 'T1' }] }]) {
    const github = fakeGithub(state);
    const board = fakeBoard({ current: 'In review' });
    const logs = await completeRun(github, { projectGithub: board });
    assert.deepEqual(cards(board), IN_PROGRESS);
    assert.match(logs.join('\n'), /PR 7: review threads unavailable\./);
  }
});

test('a human draft stays a draft, and its cards stay In progress with green checks', async () => {
  const github = fakeGithub({ pulls: [pullFixture({ draft: true })] });
  const board = fakeBoard({ current: 'In review' });
  const logs = await completeRun(github, { projectGithub: board });
  assert.equal(github.state.pulls[0].draft, true);
  assert.deepEqual(cards(board), IN_PROGRESS);
  assert.match(logs.join('\n'), /checks=true, threads resolved=false, draft=true/);
});

test('a Done card never moves back, whatever the head state', async () => {
  for (const checkRuns of [[checkRun(1, VERIFY, 'failure')], [checkRun(1, VERIFY, 'success')]]) {
    const board = fakeBoard({ current: 'Done' });
    await completeRun(fakeGithub({ checkRuns }), { projectGithub: board });
    assert.deepEqual(board.moves, []);
    assert.deepEqual(cards(board), ['Done', 'Done']);
  }
});

test('skips closed, fork and other-base PRs, and a PR that changes while the job reads', async () => {
  const cases = [
    ['closed', { pulls: [pullFixture({ state: 'closed' })] }],
    ['fork', { pulls: [pullFixture({ head: { sha, ref: 'feature', repo: { full_name: 'fork/r' } } })] }],
    ['another base', { pulls: [pullFixture({ base: { ref: 'release', repo: { full_name: 'o/r' } } })] }],
  ];
  for (const change of ['head', 'state', 'base']) {
    cases.push([`${change} changed after the checks were read`, { onRead(route) {
      if (!route.endsWith('/commits/{ref}/status')) return;
      if (change === 'head') this.pulls[0].head.sha = 'd'.repeat(40);
      if (change === 'state') this.pulls[0].state = 'closed';
      if (change === 'base') this.pulls[0].base.ref = 'release';
    } }]);
  }
  for (const [label, state] of cases) {
    const board = fakeBoard({ current: 'In progress' });
    await completeRun(fakeGithub(state), { projectGithub: board });
    assert.deepEqual(board.numbers, [], label);
    assert.deepEqual(board.moves, [], label);
  }
});

test('a PR turned draft while the job reads follows the final read', async () => {
  const github = fakeGithub({ onRead(route) { if (route === THREADS) this.pulls[0].draft = true; } });
  const board = fakeBoard({ current: 'In review' });
  await completeRun(github, { projectGithub: board });
  assert.deepEqual(cards(board), IN_PROGRESS);
});

test('ignores workflow runs that did not come from a pull request', async () => {
  for (const overrides of [{ event: 'merge_group' }, { event: 'push' }, { event: 'workflow_dispatch' }, { name: 'Other' }, { id: 0 }]) {
    const github = fakeGithub();
    const board = fakeBoard({ current: 'In progress' });
    await handleEvent({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun(github, overrides) });
    assert.deepEqual(board.numbers, []);
    assert.deepEqual(github.calls, []);
  }
  const running = fakeGithub();
  running.state.run.status = 'in_progress';
  assert.deepEqual(await discover(eventArgs({ github: running, eventName: 'workflow_run', payload: workflowRun(running) })), { numbers: [] });
  for (const eventName of ['check_run', 'pull_request_review', 'push']) {
    const github = fakeGithub();
    assert.deepEqual(await discover(eventArgs({ github, eventName, payload: { action: 'completed' } })), { numbers: [] });
    assert.deepEqual(github.calls, []);
  }
});

test('a new head keeps a ready PR ready and moves its cards to In progress', async () => {
  for (const action of ['opened', 'reopened', 'synchronize']) {
    const github = fakeGithub({ checkRuns: [] });
    const board = fakeBoard({ current: 'In review' });
    await handleEvent({ github, projectGithub: board, eventName: 'pull_request_target', payload: { action, pull_request: pullFixture() } });
    assert.equal(github.state.pulls[0].draft, false, action);
    assert.deepEqual(board.moves.map(({ optionId }) => optionId), ['opt-progress', 'opt-progress'], action);
  }
  const fork = pullFixture({ head: { sha, ref: 'feature', repo: { full_name: 'fork/r' } } });
  const board = fakeBoard({ current: 'In review' });
  await handleEvent({ github: fakeGithub({ pulls: [fork] }), projectGithub: board, eventName: 'pull_request_target',
    payload: { action: 'synchronize', pull_request: fork } });
  assert.deepEqual(board.moves, [], 'a fork PR is not synced');
  const github = fakeGithub();
  assert.deepEqual(await discover(eventArgs({ github, eventName: 'pull_request_target', payload: { action: 'labeled', pull_request: pullFixture() } })), { numbers: [] });
});

test('human flips sync the board from the live PR without changing draft state', async () => {
  for (const [action, draft, status] of [['ready_for_review', false, 'opt-review'], ['converted_to_draft', true, 'opt-progress']]) {
    const github = fakeGithub({ pulls: [pullFixture({ draft })] });
    const board = fakeBoard({ current: 'Todo' });
    // The payload is only a wake hint: its stale draft flag is not read.
    await handleEvent({ github, projectGithub: board, eventName: 'pull_request_target',
      payload: { action, pull_request: pullFixture({ draft: !draft }) } });
    assert.equal(github.state.pulls[0].draft, draft, action);
    assert.deepEqual(board.moves.map((move) => move.optionId), [status, status], action);
  }
});

test('board moves skip Done, already-set, duplicate and statusless cards', () => {
  const noStatusField = { ...boardItem('NO_FIELD', null), project: { id: 'P2', field: null } };
  const moves = boardMoves(boardData({
    pullItems: [boardItem('A', 'In progress'), boardItem('B', 'Done'), boardItem('C', null), noStatusField],
    issueItems: [boardItem('C', null), boardItem('D', 'in review'), boardItem('E', 'Todo', 'P3')],
  }), BOARD.review);
  assert.deepEqual(moves, [
    { projectId: 'P1', itemId: 'A', fieldId: 'F1', optionId: 'opt-review' },
    { projectId: 'P1', itemId: 'C', fieldId: 'F1', optionId: 'opt-review' },
    { projectId: 'P3', itemId: 'E', fieldId: 'F1', optionId: 'opt-review' },
  ]);
  assert.deepEqual(boardMoves(null, BOARD.progress), []);
});

test('board sync degrades quietly without a token or permission', async () => {
  const logs = [];
  assert.deepEqual(await syncBoard({ projectGithub: null, owner, repo, pullNumber: 7, status: BOARD.progress, log: (m) => logs.push(m) }),
    { moved: 0, skipped: 'no-token' });
  assert.deepEqual(await syncBoard({ projectGithub: fakeBoard({ fail: true }), owner, repo, pullNumber: 7, status: BOARD.progress, log: (m) => logs.push(m) }),
    { moved: 0, skipped: 'error' });
  assert.match(logs.join('\n'), /no project token[\s\S]*Resource not accessible/);
  const runLogs = await completeRun(fakeGithub(), { projectGithub: fakeBoard({ fail: true }) });
  assert.match(runLogs.join('\n'), /board follows In review[\s\S]*Board sync skipped/);
});

test('without a board token the per-PR job reads nothing', async () => {
  const github = fakeGithub(), logs = [];
  assert.equal(await syncPull({ github, owner, repo, pullNumber: 7, log: m => logs.push(m) }), 'no-token');
  assert.deepEqual(github.calls, []);
  assert.match(logs.join('\n'), /Board sync skipped for #7: no project token/);
  await assert.rejects(syncPull({ github, owner, repo, pullNumber: 0 }), /Missing trusted discovery PR number/);
});

test('a manual dispatch re-checks one PR after a thread is resolved by hand', async () => {
  const github = fakeGithub({ pulls: [pullFixture(), pullFixture({ number: 8, node_id: 'PR_8' })] });
  const board = fakeBoard({ current: 'In progress' });
  await handleEvent({ github, projectGithub: board, eventName: 'workflow_dispatch', payload: { inputs: { pr_number: '8' } } });
  assert.deepEqual(board.numbers, [8]);
  assert.deepEqual(cards(board), IN_REVIEW);
  const closed = fakeGithub({ pulls: [pullFixture({ state: 'closed' })] });
  const closedBoard = fakeBoard({ current: 'In progress' });
  await handleEvent({ github: closed, projectGithub: closedBoard, eventName: 'workflow_dispatch', payload: { inputs: { pr_number: 7 } } });
  assert.deepEqual(closedBoard.numbers, []);
  for (const pr_number of ['0', '-1', 'abc', undefined]) {
    await assert.rejects(handleEvent({ github: fakeGithub(), eventName: 'workflow_dispatch', payload: { inputs: { pr_number } } }), /positive integer/);
  }
});

test('a foreign event selects nothing and reads nothing', async () => {
  const github = fakeGithub();
  await assert.rejects(discover({ github, owner, repo, eventName: 'workflow_dispatch',
    payload: { repository: { full_name: 'evil/r' }, inputs: { pr_number: '7' } } }), /Foreign event/);
  assert.deepEqual(github.calls, []);
});

test('a review signal wakes its PR from the official association, never from its merge SHA', async () => {
  const github = fakeGithub({ signal: signalRun(), threads: [{ id: 'T1', isResolved: false }] });
  const board = fakeBoard({ current: 'In review' });
  const payload = { action: 'completed', workflow_run: structuredClone(github.state.signal) };
  await handleEvent({ github, projectGithub: board, eventName: 'workflow_run', payload });
  assert.deepEqual(cards(board), IN_PROGRESS);
  github.state.signal.workflow_id = 9;
  assert.deepEqual(await discover(eventArgs({ github, eventName: 'workflow_run', payload })), { numbers: [] });
});

test('an old CI run wakes its PR, and the job reads the live head', async () => {
  const github = fakeGithub();
  const board = fakeBoard({ current: 'In progress' });
  const old = { ...github.state.run, id: 19, head_sha: 'c'.repeat(40) };
  github.state.run = old;
  await handleEvent({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun(github) });
  assert.ok(github.calls.some(([route, params]) => route.endsWith('/commits/{ref}/check-runs') && params.ref === sha));
  assert.deepEqual(cards(board), IN_REVIEW);
});

test('CI discovery reads only its associated PRs among unrelated ones, deduped and without forks', async () => {
  const other = pullFixture({ number: 8, node_id: 'PR_8' });
  const fork = pullFixture({ number: 9, head: { sha, ref: 'feature', repo: { full_name: 'fork/r' } } });
  const unrelated = Array.from({ length: 63 }, (_, i) => pullFixture({ number: i + 100 }));
  const github = fakeGithub({ pulls: [pullFixture(), other, fork, ...unrelated] });
  const association = number => ({ number, head: { sha }, base: { ref: 'main' } });
  github.state.run.pull_requests = [association(7), association(8), association(7), association(9)];
  const logs = [];
  const input = eventArgs({ github, eventName: 'workflow_run', payload: workflowRun(github), log: m => logs.push(m) });
  assert.deepEqual(await discover(input), { numbers: [7, 8] });
  assert.deepEqual(github.calls.filter(([route]) => route === PULL).map(([, args]) => args.pull_number), [7, 8, 9]);
  assert.equal(routes(github).includes('GET /repos/{owner}/{repo}/pulls'), false, 'no repository-wide listing');
  assert.match(logs.join('\n'), /Skipped a changed or ineligible PR\./);
});

test('a missing, malformed or oversized CI association fails closed with manual recovery', async () => {
  const association = number => ({ number, head: { sha }, base: { ref: 'main' } });
  for (const pulls of [[], null, [{ number: 7 }], [association(0)], [1, 2, 3, 4, 5].map(association)]) {
    const github = fakeGithub();
    github.state.run.pull_requests = pulls;
    await assert.rejects(discover(eventArgs({ github, eventName: 'workflow_run', payload: workflowRun(github) })),
      /dispatch with pr_number for manual recovery/, JSON.stringify(pulls));
  }
});

for (const [label, checkRuns, reads, cardState] of [
  ['a red head', [checkRun(1, VERIFY, 'failure')], 5, IN_PROGRESS],
  ['a green head', undefined, 6, IN_REVIEW],
]) test(`board sync for ${label} costs ${reads} reads`, async () => {
  const github = fakeGithub(checkRuns ? { checkRuns } : {});
  const board = fakeBoard({ current: 'Todo' });
  await syncPull({ github, projectGithub: board, owner, repo, pullNumber: 7 });
  // PR, branch rules, check runs, statuses, threads when they can decide, PR.
  assert.equal(github.calls.filter(([route]) => route !== FREE).length, reads);
  assert.equal(github.calls.filter(([route]) => route === FREE).length, 1);
  assert.deepEqual(cards(board), cardState);
});

test('under the core floor the sync skips after the PR read, and a later event catches up', async () => {
  const github = fakeGithub({ coreRemaining: 799 });
  const board = fakeBoard({ current: 'In review' }), logs = [];
  assert.equal(await syncPull({ github, projectGithub: board, owner, repo, pullNumber: 7, log: m => logs.push(m) }), 'under-floor');
  assert.deepEqual(board.numbers, [], 'no project read');
  assert.deepEqual(routes(github), [PULL, FREE]);
  assert.match(logs.join('\n'), /PR 7: board sync skipped: core remaining 799 on the read token is under the floor of 800; a later event catches up\./);
});
for (const [label, state] of [['at the floor', { coreRemaining: 800 }], ['an unreadable quota', { coreRemaining: NaN }]]) {
  test(`board sync proceeds with ${label}`, async () => {
    const board = fakeBoard({ current: 'Todo' });
    assert.equal(await syncPull({ github: fakeGithub(state), projectGithub: board, owner, repo, pullNumber: 7 }), BOARD.review);
    assert.deepEqual(cards(board), IN_REVIEW);
  });
}

test('unreadable required checks or a failed final PR read skip the board sync', async () => {
  let pullReads = 0;
  for (const [fail, result, message] of [
    [route => route.endsWith('/rules/branches/{branch}'), 'checks-unavailable', /required checks unavailable; board sync skipped/],
    [route => route === PULL && ++pullReads === 2, 'pull-unavailable', /the final PR read failed/],
  ]) {
    const board = fakeBoard({ current: 'In review' }), logs = [];
    assert.equal(await syncPull({ github: fakeGithub({ fail }), projectGithub: board, owner, repo, pullNumber: 7, log: m => logs.push(m) }), result);
    assert.deepEqual(board.numbers, []);
    assert.match(logs.join('\n'), message);
  }
});

function barrier() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Execute the checked-in workflow's grouping rule. The test never substitutes
// a universal test-only lock.
async function workflowQueue(onEnqueue = () => {}) {
  const { parse } = await import('yaml');
  const workflow = parse(fs.readFileSync(workflowPath, 'utf8'));
  const expression = workflow.jobs.sync.concurrency.group;
  const slots = new Map();
  const group = number => expression.replace('${{ matrix.pr }}', String(number));
  return async args => {
    const input = eventArgs(args);
    const { numbers } = await discover(input);
    return Promise.all(numbers.map(number => {
      const result = scheduleLatest(slots, group(number), () => syncPull({ ...input, pullNumber: number }));
      onEnqueue(number);
      return result;
    }));
  };
}

// GitHub keeps one running and one pending job per group. A later pending job
// replaces the earlier pending job; it cannot interrupt the running job.
function scheduleLatest(slots, key, work) {
  return new Promise((resolve, reject) => {
    const job = { work, resolve, reject };
    const slot = slots.get(key);
    if (slot) {
      slot.pending?.resolve('coalesced');
      slot.pending = job;
    } else {
      const next = { pending: null };
      slots.set(key, next);
      startQueued(slots, key, next, job);
    }
  });
}
function startQueued(slots, key, slot, job) {
  Promise.resolve().then(job.work).then(job.resolve, job.reject).finally(() => {
    const pending = slot.pending;
    if (!pending) { slots.delete(key); return; }
    slot.pending = null;
    startQueued(slots, key, slot, pending);
  });
}

// Holds the first board read: the job has decided its status and still holds
// the PR lock, but has not moved a card yet.
function holdBoard(board) {
  const held = barrier(), release = barrier();
  const graphql = board.graphql;
  let blocked = false;
  board.graphql = async (query, variables) => {
    if (!blocked && !query.includes('updateProjectV2ItemFieldValue')) {
      blocked = true;
      held.resolve();
      await release.promise;
    }
    return graphql(query, variables);
  };
  return { held: held.promise, release: release.resolve };
}

// bound: barriers mark the exact held-read and queued-job boundaries; this
// timeout only detects a broken fixture or workflow deadlock.
test('jobs of different trigger kinds serialize per PR, so a reopened thread wins over an older green job', { timeout: 10000 }, async () => {
  const github = fakeGithub({ signal: signalRun() });
  const board = fakeBoard({ current: 'In progress' });
  const hold = holdBoard(board), queued = barrier();
  let count = 0;
  const enqueue = await workflowQueue(() => { if (++count === 2) queued.resolve(); });
  const older = enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun(github) });
  await hold.held;
  github.state.threads = [{ id: 'T1', isResolved: false }];
  const reopened = enqueue({ github, projectGithub: board, eventName: 'workflow_run',
    payload: { action: 'completed', workflow_run: structuredClone(github.state.signal) } });
  await queued.promise;
  hold.release();
  assert.deepEqual(await Promise.all([older, reopened]), [[BOARD.review], [BOARD.progress]]);
  assert.deepEqual(cards(board), IN_PROGRESS);
});

// bound: hold the old job's decision while two pending jobs coalesce.
test('a wake that replaces a pending job still reads the live state', { timeout: 10000 }, async () => {
  const github = fakeGithub({ checkRuns: [checkRun(1, VERIFY, 'failure')] });
  const board = fakeBoard({ current: 'In review' });
  const hold = holdBoard(board), pending = barrier(), replacement = barrier();
  let count = 0;
  const enqueue = await workflowQueue(() => {
    if (++count === 2) pending.resolve();
    if (count === 3) replacement.resolve();
  });
  const older = enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun(github) });
  await hold.held;
  github.state.checkRuns = [checkRun(1, VERIFY, 'failure'), checkRun(2, VERIFY, 'success')];
  const promotion = enqueue({ github, projectGithub: board, eventName: 'workflow_run', payload: workflowRun(github) });
  await pending.promise;
  const human = enqueue({ github, projectGithub: board, eventName: 'pull_request_target', payload: {
    action: 'ready_for_review', pull_request: pullFixture() } });
  await replacement.promise;
  hold.release();
  assert.deepEqual(await Promise.all([older, promotion, human]), [[BOARD.progress], ['coalesced'], [BOARD.review]]);
  assert.deepEqual(cards(board), IN_REVIEW);
});

// bound: B's board move is the signal that independent PR work progressed
// while A was held; the timeout detects accidental repository-wide serialization.
test('independent A and B events keep separate discovery and per-PR queues', { timeout: 10000 }, async () => {
  const a = fakeGithub(), b = fakeGithub({ pulls: [pullFixture({ number: 8, node_id: 'PR_8' })] });
  const boardA = fakeBoard({ current: 'In progress' }), boardB = fakeBoard({ current: 'In progress' });
  const hold = holdBoard(boardA);
  const enqueue = await workflowQueue();
  const first = enqueue({ github: a, projectGithub: boardA, eventName: 'workflow_run', payload: workflowRun(a) });
  await hold.held;
  assert.deepEqual(await enqueue({ github: b, projectGithub: boardB, eventName: 'workflow_run', payload: workflowRun(b) }), [BOARD.review]);
  assert.deepEqual(cards(boardB), IN_REVIEW);
  assert.deepEqual(boardA.moves, []);
  hold.release();
  assert.deepEqual(await first, [BOARD.review]);
  assert.deepEqual(cards(boardA), IN_REVIEW);
});

// The board sync has its own budget: a project request that never settles,
// even one that ignores its abort signal, ends the sync when the budget aborts.
test('a stalled board request ends at the board budget', async () => {
  const budget = new AbortController(), logs = [], seen = [];
  const stalled = { graphql: (query, variables) => { seen.push(variables.request); return new Promise(() => {}); } };
  const sync = syncBoard({ projectGithub: stalled, owner, repo, pullNumber: 7, status: BOARD.progress,
    log: message => logs.push(message), signal: budget.signal });
  budget.abort();
  assert.deepEqual(await sync, { moved: 0, skipped: 'error' });
  assert.match(logs.join('\n'), /board request budget exhausted/);
  assert.deepEqual(seen, [{ signal: budget.signal, retries: 0 }], 'the budget signal reaches the client, with no retries');
});

test('board requests carry an abort signal and no retries', async () => {
  const board = fakeBoard({ current: 'In progress' }), signals = [];
  const graphql = board.graphql;
  board.graphql = async (query, variables) => { signals.push(variables.request); return graphql(query, variables); };
  await syncPull({ github: fakeGithub(), projectGithub: board, owner, repo, pullNumber: 7 });
  assert.equal(signals.length, 3, 'one board read and two card moves');
  for (const request of signals) {
    assert.ok(request.signal instanceof AbortSignal);
    assert.equal(request.retries, 0);
  }
});
