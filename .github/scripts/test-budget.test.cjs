const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { isTestFile, countTestLines, budgetSection, judgeBudget, report, checkPullRequest } = require('./test-budget.cjs');

const lines = (n, prefix = 'line') => Array.from({ length: n }, (_, i) => `${prefix} ${i}\n`).join('');

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'test-budget-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
  };
  const remove = file => fs.rmSync(path.join(cwd, file));
  const commit = () => {
    git('add', '--all');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture', '--allow-empty');
    return git('rev-parse', 'HEAD').trim();
  };
  write('src/old.test.ts', lines(300, 'old'));
  write('src/app.ts', lines(10));
  const count = (base, head) => countTestLines(git, base, head);
  return { cwd, git, write, remove, commit, count, base: commit() };
}

test('test code is unit tests, browser specs and test-support code, never JSON, snapshots or declarations', () => {
  for (const file of ['a.test.ts', 'pkg/b.spec.tsx', 'web/c.e2e.ts', 'packages/web/e2e/helpers.ts', 'src/test/setup.mjs',
    'x/fixtures/data.cjs', 'src/mock-server.ts', 'src/run-harness.ts', 'src/test-helpers.js', 'a.test.jsx', 'a.test.cts', 'a.test.mts']) {
    assert.ok(isTestFile(file), file);
  }
  for (const file of ['src/app.ts', 'src/a.test.json', 'x/fixtures/data.json', 'src/__snapshots__/a.test.ts.snap',
    'src/test/types.d.ts', 'dist/a.test.js', 'node_modules/x/a.test.js', 'src/tests.ts', 'src/harness.ts', 'src/mocks.ts',
    'a.baseline.json']) {
    assert.ok(!isTestFile(file), file);
  }
});

test('net counts subtract removed test lines, ignore implementation and name new test files', (t) => {
  const r = repository(t);
  r.write('src/new.test.ts', lines(600, 'new'));
  r.write('src/old.test.ts', lines(0));
  r.write('src/app.ts', lines(500));
  r.write('src/a.test.json', lines(900));
  const count = r.count(r.base, r.commit());
  assert.equal(count.net, 300);
  assert.equal(count.added, 600);
  assert.equal(count.removed, 300);
  assert.deepEqual(count.newFiles, ['src/new.test.ts']);
  assert.deepEqual(judgeBudget({ net: count.net, body: '', labels: [] }), []);
});

test('a moved or split test file counts 0 net lines', (t) => {
  const r = repository(t);
  r.remove('src/old.test.ts');
  r.write('moved/old.test.ts', lines(300, 'old'));
  const moved = r.commit();
  assert.equal(r.count(r.base, moved).net, 0);
  r.remove('moved/old.test.ts');
  r.write('moved/one.test.ts', lines(150, 'old'));
  r.write('moved/two.test.ts', lines(150, 'two'));
  assert.equal(r.count(moved, r.commit()).net, 0);
});

test('binary test-named files carry no lines', (t) => {
  const r = repository(t);
  r.write('src/blob.test.js', Buffer.from([0, 1, 2, 0]));
  assert.equal(r.count(r.base, r.commit()).net, 0);
});

const SECTION = '## Summary\nx\n\n## Test budget\n\n`src/new.test.ts` protects the parser; no test covers it.\n\n## Verification\ny\n';

test('the thresholds: 400 passes bare, 401-1,000 needs the section, over 1,000 needs the section and the label', () => {
  assert.deepEqual(judgeBudget({ net: 400, body: '', labels: [] }), []);
  assert.match(judgeBudget({ net: 401, body: '', labels: [] }).join(), /no non-empty `## Test budget` section/);
  assert.deepEqual(judgeBudget({ net: 1000, body: SECTION, labels: [] }), []);
  assert.deepEqual(judgeBudget({ net: 1001, body: SECTION, labels: [] }), ['The PR has no `test-budget` label.']);
  assert.equal(judgeBudget({ net: 1001, body: '', labels: ['test-budget'] }).length, 1);
  assert.deepEqual(judgeBudget({ net: 1001, body: SECTION, labels: ['test-budget'] }), []);
  assert.deepEqual(judgeBudget({ net: -50, body: null, labels: [] }), []);
});

test('the section is the text under its heading, up to the next h1 or h2, with comments removed', () => {
  assert.match(budgetSection(SECTION), /^`src\/new\.test\.ts` protects the parser/);
  assert.doesNotMatch(budgetSection(SECTION), /Verification/);
  assert.match(budgetSection('## Test Budget\n### src/a.test.ts\nreason'), /reason/);
  assert.equal(budgetSection('## Test budget\n<!-- name each new file -->\n\n## Next\n'), '');
  assert.equal(budgetSection('## Test budget'), '');
  assert.equal(budgetSection('### Test budget\nreason'), '');
  assert.equal(budgetSection(undefined), '');
});

test('the report names the net count, the threshold that applies and the counted files', (t) => {
  const r = repository(t);
  r.write('src/new.test.ts', lines(1200));
  const text = report(r.count(r.base, r.commit()));
  assert.match(text, /\+1200 net test lines/);
  assert.match(text, /Over \+1000: .*`test-budget` label/);
  assert.match(text, /\| `src\/new\.test\.ts` \| \+1200 \| -0 \| yes \|/);
  assert.match(report({ net: 0, added: 0, removed: 0, files: [], newFiles: [] }), /At or under \+400/);
});

function pullRequest(t, write) {
  const r = repository(t);
  write(r);
  // Head code that would pass any count: the gate must never load it.
  r.write('.github/scripts/test-budget.cjs', 'throw new Error("head code must never run")');
  const head = r.commit();
  r.git('remote', 'add', 'origin', r.cwd);
  const pr = { number: 42, head: { sha: head }, base: { sha: r.base }, labels: [], body: '' };
  const context = { eventName: 'pull_request_target', sha: r.base, repo: { owner: 'o', repo: 'r' }, payload: { pull_request: pr } };
  const failures = [];
  const summaries = [];
  const core = {
    setFailed: message => failures.push(message),
    info: () => {},
    summary: { addRaw(text) { summaries.push(text); return this; }, write: async () => {} },
  };
  const run = () => checkPullRequest({ github: { rest: { pulls: { get: async () => ({ data: pr }) } } }, context, core, cwd: r.cwd });
  return { pr, failures, summaries, run };
}

test('trusted PR gate reads the live body and labels and writes the step summary', async (t) => {
  const p = pullRequest(t, r => r.write('src/new.test.ts', lines(1001)));
  await p.run();
  assert.match(p.failures.pop(), /no non-empty `## Test budget` section[\s\S]*no `test-budget` label[\s\S]*re-runs the failed pr-label-gates job automatically/);
  assert.match(p.summaries.pop(), /\+1001 net test lines/);
  p.pr.body = SECTION;
  p.pr.labels = [{ name: 'test-budget' }];
  await p.run();
  assert.deepEqual(p.failures, []);
});

test('trusted PR gate passes a small change and skips events without a PR', async (t) => {
  const p = pullRequest(t, r => r.write('src/new.test.ts', lines(400)));
  await p.run();
  assert.deepEqual(p.failures, []);
  assert.match(p.summaries.pop(), /\+400 net test lines/);
  await checkPullRequest({ github: {}, context: { eventName: 'push' }, core: {} });
});

test('the CLI reproduces the count and judges a body file', (t) => {
  const r = repository(t);
  r.git('branch', 'main');
  r.write('src/new.test.ts', lines(500));
  r.commit();
  const script = path.join(__dirname, 'test-budget.cjs');
  const run = (...args) => spawnSync(process.execPath, [script, '--base', 'main', ...args], { cwd: r.cwd, encoding: 'utf8' });
  const plain = run();
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /\+500 net test lines/);
  const body = path.join(r.cwd, 'body.md');
  fs.writeFileSync(body, 'no section');
  assert.equal(run('--body-file', body).status, 1);
  fs.writeFileSync(body, SECTION);
  assert.equal(run('--body-file', body).status, 0);
});
