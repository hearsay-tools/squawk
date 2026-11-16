'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { MARKER, findingLine, mergeBody, followUp } = require('./crap-follow-up.cjs');

const REPO = 'acme/widgets';
const over = (name, crap, extra = {}) => ({ file: 'src/a.ts', name, line: 10, complexity: 8, coverage: 0.25, crap, status: 'over', ...extra });

test('a finding line names the function, its scores and the pull request, keyed by file and name', () => {
  assert.equal(
    findingLine(over('build', 54.6), 'acme/widgets#7'),
    '- [ ] `src/a.ts:10` `build`: CRAP 54.6 (complexity 8, coverage 25%), from acme/widgets#7 <!-- crap:src/a.ts#build -->',
  );
});

test('same-named functions in different scopes keep separate lines', () => {
  const findings = [over('helper', 40, { scope: 'build / helper', line: 2 }), over('helper', 35, { scope: 'parse / helper', line: 9 })];
  const { body, added, updated } = mergeBody(undefined, findings, { pr: 'acme/widgets#7', limit: 30 });
  assert.deepEqual([added, updated], [2, 0]);
  assert.match(body, /<!-- crap:src\/a\.ts#build \/ helper -->/);
  assert.match(body, /<!-- crap:src\/a\.ts#parse \/ helper -->/);
  assert.match(body, /`build \/ helper`: CRAP 40\.0/);
});

test('a new body gets the header and one line per finding', () => {
  const { body, added, updated } = mergeBody(undefined, [over('a', 40), over('b', 31)], { pr: 'acme/widgets#7', limit: 30 });
  assert.equal(added, 2);
  assert.equal(updated, 0);
  assert.ok(body.startsWith(`${MARKER}\n`));
  assert.match(body, /over 30/);
  assert.equal(body.split('\n').filter((line) => line.startsWith('- [ ]')).length, 2);
  assert.ok(body.endsWith('<!-- crap:src/a.ts#b -->\n'));
});

test('a listed function gets its line replaced in place, a new one is appended, and other lines stay', () => {
  const first = mergeBody(undefined, [over('a', 40), over('b', 31)], { pr: 'acme/widgets#7', limit: 30 }).body
    .replace('- [ ] `src/a.ts:10` `b`', '- [x] `src/a.ts:10` `b`')
    .concat('A note a person added.\n');
  const { body, added, updated } = mergeBody(first, [over('b', 45), over('c', 33)], { pr: 'acme/widgets#9', limit: 30 });
  assert.equal(added, 1);
  assert.equal(updated, 1);
  const lines = body.split('\n');
  assert.equal(lines.filter((line) => line.includes('crap:src/a.ts#b')).length, 1);
  assert.match(lines.find((line) => line.includes('crap:src/a.ts#b')), /^- \[ \] .*CRAP 45\.0 .*acme\/widgets#9/);
  assert.match(lines.find((line) => line.includes('crap:src/a.ts#a')), /CRAP 40\.0 .*acme\/widgets#7/);
  assert.ok(lines.indexOf('A note a person added.') < lines.findIndex((line) => line.includes('crap:src/a.ts#c')));
});

/** A fake `gh`: `api` answers by path, `gh` records every other command. */
function fakeIo({ pulls = [], runs = [], artifacts = {}, report, issues = [] }) {
  const calls = [];
  const api = (path) => {
    if (/\/pulls\/\d+$/.test(path)) return pulls.find((pull) => path.endsWith(`/pulls/${pull.number}`)) ?? { merged_at: null };
    if (/\/commits\/\w+\/pulls$/.test(path)) return pulls;
    if (path.includes('/actions/runs?')) return { workflow_runs: runs };
    const run = /actions\/runs\/(\d+)\/artifacts/.exec(path);
    if (run) return { artifacts: artifacts[run[1]] ?? [] };
    throw new Error(`unexpected api ${path}`);
  };
  const gh = (...args) => {
    calls.push(args);
    if (args[0] === 'run' && args[1] === 'download') {
      const dir = args[args.indexOf('-D') + 1];
      require('node:fs').writeFileSync(require('node:path').join(dir, 'crap-report.json'), JSON.stringify(report));
      return '';
    }
    if (args[0] === 'issue' && args[1] === 'list') return JSON.stringify(issues);
    if (args[0] === 'issue' && args[1] === 'create') return `https://github.com/${REPO}/issues/55\n`;
    if (args[0] === 'issue' && args[1] === 'edit') {
      const file = args[args.indexOf('--body-file') + 1];
      calls.at(-1).push(require('node:fs').readFileSync(file, 'utf8'));
    }
    return '';
  };
  return { io: { gh, api }, calls };
}

const pull = { number: 7, merged_at: '2026-11-16T00:00:00Z', merge_commit_sha: 'm1', head: { sha: 'h1' } };
const ciRun = (id) => ({ id, path: '.github/workflows/ci.yml' });

test('the merge commit finds its pull request and the newest CI run that kept the report, then opens the issue', () => {
  const { io, calls } = fakeIo({
    pulls: [pull], runs: [ciRun(1), ciRun(3), { id: 4, path: '.github/workflows/other.yml' }],
    artifacts: { 1: [{ expired: false }], 3: [{ expired: false }] },
    report: { limit: 30, functions: [over('a', 40), { ...over('b', 2), status: 'pass' }] },
  });
  const lines = followUp(io, { repo: REPO, commit: 'm1' });
  assert.match(lines[0], /acme\/widgets#7 from CI run 3: 2 changed functions, 1 over 30/);
  assert.match(lines.at(-1), /^Opened acme\/widgets#55: 1 added, 0 updated\.$/);
  assert.deepEqual(calls.find((args) => args[0] === 'run').slice(0, 3), ['run', 'download', '3']);
  assert.ok(calls.some((args) => args[0] === 'label' && args.includes('crap-follow-up')));
  assert.ok(calls.some((args) => args[0] === 'issue' && args[1] === 'create'));
});

test('an open follow-up issue is edited, and a dry run writes nothing', () => {
  const existing = { number: 12, body: mergeBody(undefined, [over('a', 40)], { pr: 'acme/widgets#3', limit: 30 }).body };
  const setup = { pulls: [pull], runs: [ciRun(3)], artifacts: { 3: [{ expired: false }] }, report: { limit: 30, functions: [over('a', 50)] }, issues: [existing] };

  const dry = fakeIo(setup);
  const preview = followUp(dry.io, { repo: REPO, pr: '7', dryRun: true });
  assert.match(preview[1], /Dry run: would edit #12 \(0 added, 1 updated\)/);
  assert.ok(!dry.calls.some((args) => args[0] === 'issue' && args[1] !== 'list'));

  const real = fakeIo(setup);
  const lines = followUp(real.io, { repo: REPO, pr: '7' });
  assert.match(lines.at(-1), /^Updated acme\/widgets#12: 0 added, 1 updated\.$/);
  const edit = real.calls.find((args) => args[1] === 'edit');
  assert.match(edit.at(-1), /CRAP 50\.0 .*acme\/widgets#7/);
  assert.doesNotMatch(edit.at(-1), /CRAP 40\.0/);
});

test('no merged pull request, no report, or no finding files nothing', () => {
  assert.match(followUp(fakeIo({ pulls: [] }).io, { repo: REPO, commit: 'm1' })[0], /No merged pull request for m1/);
  const noReport = fakeIo({ pulls: [pull], runs: [ciRun(3)], artifacts: { 3: [{ expired: true }] } });
  assert.match(followUp(noReport.io, { repo: REPO, commit: 'm1' })[0], /No `crap-report-h1` artifact for acme\/widgets#7/);
  const clean = fakeIo({ pulls: [pull], runs: [ciRun(3)], artifacts: { 3: [{ expired: false }] }, report: { limit: 30, functions: [{ ...over('a', 3), status: 'pass' }] } });
  const lines = followUp(clean.io, { repo: REPO, commit: 'm1' });
  assert.equal(lines.length, 1);
  assert.ok(!clean.calls.some((args) => args[0] === 'issue'));
});

test('the follow-up workflow runs trusted main code after a push, one run at a time, and dispatches dry by default', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const yaml = require('yaml');
  const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', 'crap-follow-up.yml'), 'utf8'));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.workflow_dispatch.inputs.dry_run.default, true);
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.concurrency, { group: 'crap-follow-up', queue: 'max', 'cancel-in-progress': false });
  const job = workflow.jobs['follow-up'];
  assert.equal(job.if, "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  assert.deepEqual(job.permissions, { actions: 'read', contents: 'read', issues: 'write', 'pull-requests': 'read' });
  assert.equal(job.steps[0].with.ref, '${{ github.sha }}');
  assert.equal(job.steps[0].with['persist-credentials'], false);
  const step = job.steps[1];
  assert.deepEqual(step.run.match(/\$\{\{[^}]*\}\}/g) ?? [], [], 'expressions stay in env');
  assert.match(step.run, /node \.github\/scripts\/crap-follow-up\.cjs --repo "\$REPOSITORY"/);
});
