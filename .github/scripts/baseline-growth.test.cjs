const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { compareBaseline, movedBetween, checkBaselineGrowth } = require('./baseline-growth.cjs');

const root = path.resolve(__dirname, '../..');
const formats = [
  'packages/cezar/src/test-wait-discipline.baseline.json',
  'packages/web/src/test/e2e-wait-discipline.baseline.json',
  'packages/web/src/test/search-params-discipline.baseline.json',
  'packages/web/src/test/card-2-contrast.baseline.json',
  '.github/agents-md.baseline.json',
];
for (const file of formats) {
  test(`pins growth and shrinkage for ${file}`, () => {
    const before = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    assert.deepEqual(compareBaseline(before, structuredClone(before)), []);
    const after = structuredClone(before);
    const entries = Array.isArray(after) ? after : after.sites;
    if (entries) {
      entries.push(typeof entries[0] === 'string' ? 'new-site' : { ...entries[0], file: 'new.test.ts' });
      assert.ok(compareBaseline(before, after).length);
      entries.pop();
      entries.pop();
    } else {
      after.maxBytes++;
      assert.ok(compareBaseline(before, after).length);
      after.maxBytes -= 2;
    }
    assert.deepEqual(compareBaseline(before, after), []);
  });
}

test('numeric allowances cannot grow, entries can reorder, metadata can change', () => {
  const before = { $comment: 'old', sites: [{ file: 'a', count: 2 }, { file: 'b', count: 1 }] };
  assert.deepEqual(compareBaseline(before, { ...before, $comment: 'new', sites: [...before.sites].reverse() }), []);
  assert.deepEqual(compareBaseline(before, { sites: [{ file: 'a', count: 1 }] }), []);
  assert.ok(compareBaseline(before, { sites: [{ file: 'a', count: 3 }] }).length);
  assert.ok(compareBaseline(['a'], ['a', 'a']).length, 'duplicate entries also grow the allowance');
  assert.ok(compareBaseline({ max: 2 }, { max: 2, extra: 1 }).length);
  assert.ok(compareBaseline({ max: 2 }, { max: 'unlimited' }).length);
});

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-growth-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-q');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
  };
  const commit = () => {
    git('add', '.');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  write('deep/space name.baseline.json', '{"max":2}');
  write('reader.test.cjs', "readFileSync('deep/space name.baseline.json')");
  return { cwd, git, write, commit, base: commit() };
}

test('git comparison discovers arbitrary paths, new files pass, and overrides only CI growth', (t) => {
  const r = repository(t);
  r.write('deep/space name.baseline.json', '{"max":3}');
  r.write('.hidden/new.baseline.json', '{"allowances":["first"]}');
  const head = r.commit();
  const input = { cwd: r.cwd, base: r.base, head };
  assert.match(checkBaselineGrowth(input).join('\n'), /space name/);
  assert.deepEqual(checkBaselineGrowth({ ...input, allowGrowth: true }), []);
  r.write('deep/space name.baseline.json', '{"max":1}');
  assert.deepEqual(checkBaselineGrowth({ ...input, head: r.commit() }), []);
});

test('deleted baselines require removing literal readers, even with the override', (t) => {
  const r = repository(t);
  fs.unlinkSync(path.join(r.cwd, 'deep/space name.baseline.json'));
  const head = r.commit();
  for (const allowGrowth of [false, true]) {
    assert.match(checkBaselineGrowth({ cwd: r.cwd, base: r.base, head, allowGrowth }).join('\n'), /reader.test.cjs/);
  }
  r.write('reader.test.cjs', '// removed reader');
  assert.deepEqual(checkBaselineGrowth({ cwd: r.cwd, base: r.base, head: r.commit() }), []);
});

test('invalid JSON fails closed, including new files and an override', (t) => {
  const r = repository(t);
  r.write('new.baseline.json', 'invalid');
  assert.throws(() => checkBaselineGrowth({ cwd: r.cwd, base: r.base, head: r.commit(), allowGrowth: true }));
});

test('trusted PR gate uses live labels and head blobs, and refuses changed metadata', async (t) => {
  const { checkPullRequest } = require('./baseline-growth.cjs');
  const r = repository(t);
  r.write('deep/space name.baseline.json', '{"max":3}');
  r.write('.github/scripts/baseline-growth.cjs', 'throw new Error("head code must never run")');
  const head = r.commit();
  r.git('remote', 'add', 'origin', r.cwd);
  r.git('update-ref', 'refs/pull/42/head', head);
  const context = { eventName: 'pull_request_target', sha: r.base, repo: { owner: 'owner', repo: 'repo' },
    payload: { pull_request: { number: 42, head: { sha: head }, base: { sha: r.base } } } };
  let pr = { head: { sha: head }, base: { sha: r.base }, labels: [] };
  const github = { rest: { pulls: { get: async () => ({ data: pr }) } } };
  const failures = [];
  const info = [];
  const core = { setFailed: message => failures.push(message), info: message => info.push(message) };
  const input = { github, context, core, cwd: r.cwd };
  await checkPullRequest(input);
  const failure = failures.pop();
  assert.match(failure, /number grew/);
  assert.match(failure, /add the baseline-growth label, then re-run the failed classify-pr job/);
  pr.labels = [{ name: 'baseline-growth' }];
  await checkPullRequest(input);
  assert.equal(failures.length, 0);
  assert.match(info.pop(), /owner merge/);
  r.git('checkout', '--detach', r.base);
  await checkPullRequest({ ...input, context: { ...context, eventName: 'workflow_dispatch',
    sha: head, payload: { inputs: { pr_number: '42' } } } });
  assert.match(info.pop(), /owner merge/);
  await assert.rejects(checkPullRequest({ ...input, context: { ...context, eventName: 'workflow_dispatch',
    payload: { inputs: { pr_number: 'bad' } } } }), /Invalid PR number/);
  pr.head.sha = 'a'.repeat(40);
  await assert.rejects(checkPullRequest(input), /PR changed/);
  pr.head.sha = head;
  pr.base.sha = 'b'.repeat(40);
  await assert.rejects(checkPullRequest(input), /PR changed/);
  pr.base.sha = r.base;
  let reads = 0;
  github.rest.pulls.get = async () => ({ data: ++reads === 1 ? pr : { ...pr, head: { sha: r.base } } });
  await assert.rejects(checkPullRequest(input), /changed during fetch/);
  assert.equal(reads, 2);
  await checkPullRequest({ ...input, context: { eventName: 'push' } });
});

test('trusted PR gate measures from the branch tip it runs from, not the stale event base.sha', async (t) => {
  // GitHub keeps base.sha at the PR's opening commit. The base branch then raises a ratchet
  // (owner-approved, with the label), and the PR rebases onto it without touching the baseline.
  const { checkPullRequest } = require('./baseline-growth.cjs');
  const r = repository(t);
  r.write('deep/space name.baseline.json', '{"max":3}');
  const tip = r.commit();
  r.write('feature.txt', 'the PR change');
  const head = r.commit();
  r.git('remote', 'add', 'origin', r.cwd);
  r.git('update-ref', 'refs/pull/42/head', head);
  const stale = { sha: r.base };
  const context = { eventName: 'pull_request_target', sha: tip, repo: { owner: 'owner', repo: 'repo' },
    payload: { pull_request: { number: 42, head: { sha: head }, base: stale } } };
  const pr = { head: { sha: head }, base: stale, labels: [] };
  const failures = [];
  const core = { setFailed: message => failures.push(message), info: () => {} };
  await checkPullRequest({ github: { rest: { pulls: { get: async () => ({ data: pr }) } } }, context, core, cwd: r.cwd });
  assert.deepEqual(failures, []);
});

test('trusted PR gate fetches the head commit before the PR ref exists', async (t) => {
  const { checkPullRequest } = require('./baseline-growth.cjs');
  const r = repository(t);
  r.write('feature.txt', 'the PR change');
  const head = r.commit();
  r.git('remote', 'add', 'origin', r.cwd);
  assert.equal(spawnSync('git', ['show-ref', '--verify', 'refs/pull/42/head'], { cwd: r.cwd }).status, 128);
  const pr = { number: 42, head: { sha: head }, base: { sha: r.base }, labels: [] };
  const context = { eventName: 'pull_request_target', sha: r.base, repo: { owner: 'owner', repo: 'repo' },
    payload: { pull_request: pr } };
  const messages = [];
  const core = { setFailed: message => assert.fail(message), info: message => messages.push(message) };
  await checkPullRequest({ github: { rest: { pulls: { get: async () => ({ data: pr }) } } }, context, core, cwd: r.cwd });
  assert.equal(r.git('rev-parse', 'FETCH_HEAD'), head);
  assert.deepEqual(messages, ['Baseline ratchets did not grow.']);
});

test('duplicate site counts can reorder without consuming the wrong allowance', () => {
  assert.deepEqual(compareBaseline([{ file: 'a', count: 2 }, { file: 'a', count: 1 }],
    [{ file: 'a', count: 1 }, { file: 'a', count: 2 }]), []);
});

function autoMerge(r, head, title = 'ci: improve checks') {
  return spawnSync(process.execPath, [path.join(root, '.ai/skills/auto-merge/check.mjs'),
    '--title', title, '--base', r.base, '--head', head], { cwd: r.cwd, encoding: 'utf8' });
}

test('auto-merge rejects numeric growth and allows a shrinking baseline', (t) => {
  const r = repository(t);
  r.write('deep/space name.baseline.json', '{"max":3}');
  const growth = autoMerge(r, r.commit());
  assert.equal(growth.status, 1, growth.stdout + growth.stderr);
  assert.match(growth.stdout, /^- ratchet baseline growth: .*deep\/space name\.baseline\.json/m);
  r.write('deep/space name.baseline.json', '{"max":1}');
  const shrink = autoMerge(r, r.commit());
  assert.equal(shrink.status, 0, shrink.stdout + shrink.stderr);
  r.write('.github/scripts/baseline-growth.cjs', '// guard changes need owner review');
  assert.match(autoMerge(r, r.commit()).stdout, /gate or test harness/);
});

test('CI permits a new ratchet, while auto-merge requires owner review of its starting debt', (t) => {
  const r = repository(t);
  r.write('new.baseline.json', '{"max":100}');
  const head = r.commit();
  assert.deepEqual(checkBaselineGrowth({ cwd: r.cwd, base: r.base, head }), []);
  const result = autoMerge(r, head);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /new ratchet baseline: new.baseline.json/);
});


for (const [name, file] of [
  ['contrast', 'packages/cezar/src/lint/card-2-contrast.test.ts'],
  ['design guardian', 'packages/cezar/src/lint/design-guardian.test.ts'],
  ['server wait discipline', 'packages/cezar/src/test-wait-discipline.test.ts'],
  ['unit wait discipline', 'packages/cezar/src/lint/unit-wait-discipline.test.ts'],
  ['wait runner', 'packages/cezar/src/lint/wait-discipline-runner.test.ts'],
]) {
  test(`auto-merge protects the moved ${name} fixtures while permitting added cases`, (t) => {
    const r = repository(t);
    const fixture = "it('keeps contrast', () => assert.equal(scan('unsafe').length, 1));\n";
    r.write(file, fixture);
    r.base = r.commit();
    r.write(file, fixture.replace("length, 1", "length, 0"));
    const changed = autoMerge(r, r.commit());
    assert.equal(changed.status, 1, changed.stdout + changed.stderr);
    assert.match(changed.stdout, /guard test change/);
    r.write(file, fixture + "it('adds a case', () => assert.equal(scan('safe').length, 0));\n");
    const added = autoMerge(r, r.commit());
    assert.equal(added.status, 0, added.stdout + added.stderr);
  });
}

// The M07 wait rule engines and their fixtures keep the old guard's owner-review requirement.
test('auto-merge protects moved unit wait scanners and fixtures while permitting added cases', (t) => {
  const r = repository(t);
  const files = [
    'blank.ts', 'server-wait-tree.ts', 'server-wait-names.ts', 'server-wait-values.ts', 'server-wait-options.ts',
    'server-wait-loops.ts', 'server-wait-baseline.ts', 'test-wait-discipline.ts', 'unit-wait-values.ts', 'unit-wait-deadlines.ts',
    'wait-baseline.ts', 'unit-wait-discipline.ts', 'wait-source.ts', 'wait-oxlint.ts', 'wait-babel-tree.ts',
    'wait-discipline-runner.ts',
  ].map(file => `packages/cezar/src/lint/${file}`);
  const fixture = "export const expected = 1;\n";
  for (const file of files) r.write(file, fixture);
  r.base = r.commit();
  for (const file of files) {
    r.write(file, fixture.replace('= 1', '= 0'));
    const changed = autoMerge(r, r.commit());
    assert.equal(changed.status, 1, changed.stdout + changed.stderr);
    assert.match(changed.stdout, /guard test change/);
    r.write(file, fixture);
  }
  r.write(files[0], fixture + 'export const another = 2;\n');
  const added = autoMerge(r, r.commit());
  assert.equal(added.status, 0, added.stdout + added.stderr);
});


test('a pin follows its moved file one for one; other path changes and growth still fail', () => {
  const moved = movedBetween(['old.ts', 'kept.ts', 'other.ts'], ['new.ts', 'kept.ts', 'other.ts', 'second.ts']);
  const entries = { entries: [{ file: 'old.ts', target: 'kept.ts', count: 2, reason: 'r' }] };
  const at = (fields) => ({ entries: [{ ...entries.entries[0], ...fields }] });
  assert.deepEqual(compareBaseline(entries, at({ file: 'new.ts' }), '$', moved), []);
  assert.deepEqual(compareBaseline(entries, at({ file: 'new.ts', count: 1 }), '$', moved), []);
  assert.ok(compareBaseline(entries, at({ file: 'new.ts' })).length, 'without the moves, a new path is a new entry');
  assert.ok(compareBaseline(entries, at({ file: 'new.ts', count: 3 }), '$', moved).length);
  assert.ok(compareBaseline(entries, at({ file: 'other.ts' }), '$', moved).length, 'a file the change did not add');
  assert.ok(compareBaseline(entries, at({ file: 'new.ts', reason: 'changed' }), '$', moved).length);
  assert.ok(compareBaseline(entries, { entries: [...at({ file: 'new.ts' }).entries, ...at({ file: 'second.ts' }).entries] }, '$', moved).length, 'one entry relocates once');

  const pins = { limit: 1000, files: { 'old.ts': 1200, 'kept.ts': 1100 } };
  assert.deepEqual(compareBaseline(pins, { limit: 1000, files: { 'new.ts': 1200, 'kept.ts': 1100 } }, '$', moved), []);
  assert.ok(compareBaseline(pins, { limit: 1000, files: { 'new.ts': 1201, 'kept.ts': 1100 } }, '$', moved).length);
  assert.ok(compareBaseline(pins, { limit: 1000, files: { 'new.ts': 1200, 'second.ts': 1200, 'kept.ts': 1100 } }, '$', moved).length);
  assert.ok(compareBaseline(pins, { limit: 1000, files: { 'old.ts': 1200, 'new.ts': 1200, 'kept.ts': 1100 } }, '$', moved).length, 'a kept key cannot also move');
});

test('git comparison accepts a pin that only follows its moved file, with no label', (t) => {
  const r = repository(t);
  r.write('src/old.ts', 'export {};\n');
  r.write('pins.baseline.json', '{"files":{"src/old.ts":1200},"entries":[{"file":"src/old.ts","count":2}]}');
  const base = r.commit();
  r.git('mv', 'src/old.ts', 'src/new.ts');
  r.write('pins.baseline.json', '{"files":{"src/new.ts":1200},"entries":[{"file":"src/new.ts","count":2}]}');
  assert.deepEqual(checkBaselineGrowth({ cwd: r.cwd, base, head: r.commit() }), []);
  r.write('pins.baseline.json', '{"files":{"src/new.ts":1201},"entries":[{"file":"src/new.ts","count":2}]}');
  assert.match(checkBaselineGrowth({ cwd: r.cwd, base, head: r.commit() }).join('\n'), /files\.src\/new\.ts: added an entry/);
});

test('relocated keys match one for one whatever their order', () => {
  const moved = movedBetween(['a.ts', 'b.ts'], ['c.ts', 'd.ts']);
  assert.deepEqual(compareBaseline({ files: { 'a.ts': 1200, 'b.ts': 1100 } }, { files: { 'c.ts': 1100, 'd.ts': 1200 } }, '$', moved), []);
  assert.ok(compareBaseline({ files: { 'a.ts': 1200, 'b.ts': 1100 } }, { files: { 'c.ts': 1200, 'd.ts': 1200 } }, '$', moved).length);
});

test('a pin that names its file below a shared directory, or inside a longer string, follows the move', () => {
  const moved = movedBetween(['packages/web/src/routes/task-git/task-files.tsx', 'packages/web/src/routes/kept.tsx'],
    ['packages/web/src/routes/task-git/moved-files.tsx', 'packages/web/src/routes/kept.tsx', 'packages/web/src/other/moved-files.tsx']);
  const site = { file: 'routes/task-git/task-files.tsx', site: 'useSearchParams()', reason: 'r' };
  assert.deepEqual(compareBaseline({ sites: [site] }, { sites: [{ ...site, file: 'routes/task-git/moved-files.tsx' }] }, '$', moved), []);
  assert.deepEqual(compareBaseline(['routes/task-git/task-files.tsx: <Button>'], ['routes/task-git/moved-files.tsx: <Button>'], '$', moved), []);
  assert.ok(compareBaseline(['routes/task-git/task-files.tsx: <Button>'], ['routes/task-git/moved-files.tsx: <Link>'], '$', moved).length);
  assert.ok(compareBaseline({ sites: [site] }, { sites: [{ ...site, file: 'routes/kept.tsx' }] }, '$', moved).length, 'a file that stayed');
  assert.ok(compareBaseline({ sites: [site] }, { sites: [{ ...site, file: 'other/missing.tsx' }] }, '$', moved).length, 'a path the change did not add');
});
