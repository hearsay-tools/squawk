'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture, secondEntry, SHA, BASE, HEAD, MAIN } = require('./merge-queue.testkit.cjs');
const { admissionFailure } = require('./merge-queue-admission.cjs');
test('request failures name the API route, error and HTTP status without credentials', async () => {
  const h = fixture();
  const diagnostics = {};
  const { mergeQueueAdmission } = require('./merge-queue-admission.cjs');
  const github = { request: async () => {
    throw Object.assign(new Error('Resource not accessible by integration\nAuthorization: Bearer private-value'), {
      name: 'HttpError', status: 403, request: { headers: { authorization: 'private-header' } },
    });
  } };
  await assert.rejects(() => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: h.s.group, diagnostics }), error => {
    const diagnostic = admissionFailure(error, diagnostics);
    assert.match(diagnostic, /GET \/repos\/\{owner\}\/\{repo\}\/rules\/branches\/\{branch\}/);
    assert.match(diagnostic, /HttpError/);
    assert.match(diagnostic, /403/);
    assert.match(diagnostic, /Resource not accessible by integration/);
    assert.doesNotMatch(diagnostic, /private-value|private-header/);
    assert.deepEqual(diagnostics.api, { route: 'GET /repos/{owner}/{repo}/rules/branches/{branch}', status: 403 });
    assert.equal(diagnostics.check, 'queue rules');
    return true;
  });
});
test('GraphQL failures report the API error instead of only incomplete evidence', async () => {
  const h = fixture();
  const { mergeQueueAdmission } = require('./merge-queue-admission.cjs');
  const github = { request: async (route, args) => route === 'POST /graphql'
    ? { data: { errors: [{ message: 'Resource not accessible by integration' }] } }
    : h.github.request(route, args) };
  await assert.rejects(() => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: h.s.group }),
    /POST \/graphql.*Resource not accessible by integration/);
});
test('admission diagnostics redact signed URLs and prevent workflow command injection', () => {
  const diagnostic = admissionFailure(new Error('Request failed https://user:private@example.test/path?signature=private\n::error::injected'));
  assert.match(diagnostic, /example.test\/path/);
  assert.doesNotMatch(diagnostic, /private|::error::/);
});
for (const fork of [false, true]) test(`valid native head admitted (fork=${fork})`, async () => {
  const h = fixture(fork); assert.equal((await h.run()).pullNumber, 7);
});
for (const [label, mutate] of Object.entries({
  'build concurrency 2': s => { s.rules[0].parameters.max_entries_to_build = 2; },
  'entry 1 with an entry behind': s => { s.entries = [s.entry, { ...s.entry, id: 'next', position: 2, headCommit: { oid: MAIN }, baseCommit: { oid: SHA } }]; },
  'entry 2 built on entry 1': secondEntry,
  'entry 2 at build concurrency 2': s => { secondEntry(s); s.rules[0].parameters.max_entries_to_build = 2; },
})) test(`admission accepts: ${label}`, async () => {
  const h = fixture(); mutate(h.s); assert.equal((await h.run()).pullNumber, 7);
});
test('entry 2 that moves to position 1 before the final reread is admitted', async () => {
  const h = fixture(); secondEntry(h.s); let reads = 0;
  h.s.onRead = (route, args) => {
    if (route === 'POST /graphql' && args.query.includes('mergeQueue(') && ++reads === 2) {
      h.s.entries = [h.s.entry]; h.s.entry.position = 1;
    }
  };
  // Entry 1 merged between the reads: entry 2 is now first, and its base is main.
  assert.equal((await h.run()).pullNumber, 7); assert.equal(reads, 2);
});
for (const [label, mutate] of Object.entries({
  'missing entry': s => { s.entries = []; },
  'duplicate entry': s => { s.entries = [s.entry, s.entry]; },
  'wrong combined SHA': s => { s.entry.headCommit.oid = HEAD; },
  'wrong base': s => { s.entry.baseCommit.oid = HEAD; },
  'second entry without a first': s => { s.entry.position = 2; },
  'third position': s => { secondEntry(s); s.entry.position = 3; },
  'second entry not built on the first': s => { secondEntry(s); s.first.headCommit.oid = MAIN; },
  'second entry beside two firsts': s => { secondEntry(s); s.entries = [s.first, { ...s.first, id: 'other' }, s.entry]; },
  'stale group': s => { secondEntry(s); s.entry.headCommit.oid = HEAD; },
  'changed PR head': s => { s.pr.head.sha = SHA; },
  'draft': s => { s.pr.draft = true; },
  'closed': s => { s.pr.state = 'closed'; },
  'wrong target': s => { s.pr.base.ref = 'release'; },
  'build concurrency 3': s => { s.rules[0].parameters.max_entries_to_build = 3; },
  'build concurrency 0': s => { s.rules[0].parameters.max_entries_to_build = 0; },
  'multi merge': s => { s.rules[0].parameters.max_entries_to_merge = 2; },
  'missing rule': s => { s.rules = []; },
  'foreign Actions integration': s => { s.rules[1].parameters.required_status_checks[0].integration_id = 2; },
  'thread protection disabled': s => { s.rules[2].parameters.required_review_thread_resolution = false; },
  'unresolved thread': s => { s.threads = [{ id: 't', isResolved: false }]; },
  'dispatch run': s => { s.run.event = 'workflow_dispatch'; },
  'foreign workflow': s => { s.run.workflow_id = 4; },
  'foreign repository': s => { s.run.repository.full_name = 'evil/r'; },
  'foreign head': s => { s.run.head_repository.full_name = 'evil/r'; },
  'wrong attribution': s => { s.run.pull_requests[0].number = 8; },
  'newer failed run': s => { s.runs = [s.run, { ...s.run, id: 21, conclusion: 'failure' }]; },
  'pending native run': s => { s.run.status = 'in_progress'; },
  'skipped verify job': s => { s.jobs[0].conclusion = 'skipped'; },
  'missing verify job': s => { s.jobs.pop(); },
  'duplicate verify job': s => { s.jobs.push({ ...s.jobs[0], id: 3 }); },
  'API failure': s => { s.fail = true; },
})) test(`admission fails closed: ${label}`, async () => {
  const h = fixture(); mutate(h.s); await assert.rejects(h.run);
});
test('a later paginated unresolved thread blocks admission', async () => {
  const h = fixture(); h.s.nextThreads = true;
  h.s.onRead = (route, args) => { if (args.variables?.cursor) h.s.threads = [{ id: 'later', isResolved: false }]; };
  await assert.rejects(h.run, /Unresolved/);
});
for (const target of ['queue', 'head', 'attempt']) test(`final reread rejects moving ${target}`, async () => {
  const h = fixture(); let reads = 0;
  h.s.onRead = route => {
    const match = target === 'queue' ? route === 'POST /graphql' : target === 'head' ? route.endsWith('/pulls/{pull_number}') : route.endsWith('/runs/{run_id}');
    if (match && ++reads === 2) {
      if (target === 'queue') h.s.entry.id = 'new';
      if (target === 'head') h.s.pr.head.sha = SHA;
      if (target === 'attempt') h.s.run.run_attempt++;
    }
  };
  await assert.rejects(h.run);
});

test('final admission keeps rejecting an in-progress workflow even when required gates passed', async () => {
  const h = fixture(); h.s.run.status = 'in_progress'; h.s.run.conclusion = null;
  await assert.rejects(h.run, /has not passed/);
});

test('an outdated unresolved thread blocks admission', async () => {
  const h = fixture(); h.s.threads = [{ id: 'open', isResolved: false, isOutdated: true }];
  await assert.rejects(h.run, /Unresolved review threads/);
});
test('a skipped native verify job blocks admission', async () => {
  const h = fixture(); h.s.jobs[0].conclusion = 'skipped';
  await assert.rejects(h.run, /Native CI gate missing/);
});
test('queue refuses a draft', async () => {
  const h = fixture(); h.s.pr.draft = true;
  await assert.rejects(h.run, /PR head is no longer eligible/);
});

// hearsay-tools/squawk#3359: one transient GitHub answer dropped a green PR from the queue.
const httpError = (status, message, headers = {}) => Object.assign(new Error(message), { name: 'HttpError', status, response: { headers } });
function failFirst(h, matches, error) {
  const original = h.github.request; let failed = 0;
  const github = { request: async (route, args) => {
    if (matches(route, args) && failed++ === 0) { h.s.calls.push(route); throw error; }
    return original(route, args);
  } };
  const sleeps = [];
  const run = () => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: h.s.group, sleep: async ms => { sleeps.push(ms); } });
  return { run, sleeps };
}
const { mergeQueueAdmission } = require('./merge-queue-admission.cjs');
for (const [label, matches] of Object.entries({
  rules: route => route.endsWith('/rules/branches/{branch}'),
  'queue GraphQL': (route, args) => args.query?.includes('mergeQueue('),
  'run jobs': route => route.endsWith('/runs/{run_id}/jobs'),
  'review threads': (route, args) => args.query?.includes('reviewThreads'),
})) test(`one transient 500 on the ${label} read is retried and admits`, async () => {
  const h = fixture();
  const { run, sleeps } = failFirst(h, matches, httpError(500, 'The operation was aborted due to timeout'));
  assert.equal((await run()).pullNumber, 7);
  assert.deepEqual(sleeps, [1000]);
});
test('a secondary rate limit waits for its retry-after, then admits', async () => {
  const h = fixture();
  const { run, sleeps } = failFirst(h, route => route.endsWith('/pulls/{pull_number}'),
    httpError(403, 'You have exceeded a secondary rate limit', { 'retry-after': '2' }));
  assert.equal((await run()).pullNumber, 7);
  assert.deepEqual(sleeps, [2000]);
});
test('a real refusal fails at once, and a lasting 5xx fails after three attempts', async () => {
  for (const [error, attempts] of [[httpError(403, 'Resource not accessible by integration'), 1], [httpError(404, 'Not Found'), 1], [httpError(502, 'Bad Gateway'), 3]]) {
    const calls = []; const sleeps = [];
    const github = { request: async route => { calls.push(route); throw error; } };
    await assert.rejects(() => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: fixture().s.group, sleep: async ms => { sleeps.push(ms); } }),
      new RegExp(error.message));
    assert.equal(calls.length, attempts, error.message);
    assert.deepEqual(sleeps, [1000, 2000].slice(0, attempts - 1));
  }
});
test('a retry wait that would pass the deadline fails instead', async () => {
  const h = fixture(); let clock = 0;
  const github = { request: async () => { clock = 119500; throw httpError(500, 'Server Error'); } };
  await assert.rejects(() => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: h.s.group, now: () => clock,
    sleep: async () => assert.fail('no wait past the deadline') }), /Server Error/);
});
test('a PR turned draft during admission is refused by the final PR read', async () => {
  const h = fixture(); let reads = 0;
  h.s.onRead = route => { if (route.endsWith('/pulls/{pull_number}') && ++reads === 2) h.s.pr.draft = true; };
  await assert.rejects(h.run, /Queue or PR changed/);
});
test('one admission reads each record once, apart from the race re-reads', async () => {
  const h = fixture(); await h.run();
  // rules, queue, PR, workflow, runs, run, jobs, threads; final run, runs, queue, PR.
  assert.equal(h.s.calls.length, 12);
  assert.equal(h.s.calls.filter(route => route.endsWith('/rules/branches/{branch}')).length, 1);
});
test('the thread read shares the admission deadline, so no retry wait passes it', async () => {
  const h = fixture(); let clock = 0; const sleeps = [];
  const original = h.github.request; let failed = false;
  const github = { request: async (route, args) => {
    // The thread read starts 100 s into the 120 s admission budget.
    if (args.query?.includes('reviewThreads') && !failed) {
      failed = true; clock = 100000;
      throw httpError(403, 'You have exceeded a secondary rate limit', { 'retry-after': '30' });
    }
    return original(route, args);
  } };
  await assert.rejects(() => mergeQueueAdmission({ github, owner: 'o', repo: 'r', group: h.s.group, now: () => clock,
    sleep: async ms => { sleeps.push(ms); } }), /secondary rate limit/);
  assert.deepEqual(sleeps, []);
});
