import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { complexityRun, daemonAlive, fallbackLines, focusedTests, gitIo, judgeSqueal, lintFallbackLine, loweredNotes, lintUnfinished, patchLimitLines, prepr, SQUEAL_WAIT_MS, squealChecks, squealLines, testBudgetLines } from './prepr.mjs';

const { GITHUB_PATCH_LIMITS, numstatRows } = createRequire(import.meta.url)('../.github/scripts/missing-patches.cjs');

const file = (path, state, verdict) => ({ path, state, ...(verdict ? { verdict } : {}) });
const status = (testFiles, extra = {}) => ({ selection: { testFiles, verdict: { failures: { tests: 0, testFiles: 0 } } }, lint: { failing: 0, linting: { done: 1, total: 1 } }, ...extra });

test('the Squeal wait bound is 2 minutes', () => assert.equal(SQUEAL_WAIT_MS, 120_000));

test('current passing files and clean lint pass', () => {
  assert.equal(judgeSqueal(0, status([file('a.test.ts', 'current', 'pass')])).state, 'pass');
});

test('a failing current file fails and is named', () => {
  const r = judgeSqueal(1, status([file('a.test.ts', 'current', 'fail')]));
  assert.deepEqual([r.state, r.failed], ['fail', ['a.test.ts']]);
});

test('exit 1 fails even without a named file', () => {
  assert.equal(judgeSqueal(1, status([])).state, 'fail');
});

test('a lint finding fails', () => {
  assert.equal(judgeSqueal(0, status([], { lint: { failing: 2 } })).state, 'fail');
});

test('missing results name the files and are incomplete', () => {
  const r = judgeSqueal(3, status([file('a.test.ts', 'current', 'pass'), file('b.test.ts', 'pending')]));
  assert.deepEqual([r.state, r.missing], ['incomplete', ['b.test.ts']]);
});

test('unfinished lint leaves the tests\' verdict alone and marks lint unfinished', () => {
  const r = judgeSqueal(0, status([], { lint: { failing: 0, pending: 3 } }));
  assert.deepEqual([r.state, lintUnfinished(r.lint)], ['pass', true]);
});

test('only a live daemon counts', () => {
  assert.equal(daemonAlive({ available: true, daemon: { state: 'alive' } }), true);
  assert.equal(daemonAlive({ available: false }), false);
  assert.equal(daemonAlive(undefined), false);
});

test('browser specs without a result do not count as missing', () => {
  const r = judgeSqueal(3, status([file('packages/web/e2e/a.e2e.ts', 'pending'), file('a.test.ts', 'current', 'pass')]));
  assert.equal(r.state, 'pass');
});

test('a skipped current file is not a failure', () => {
  assert.equal(judgeSqueal(0, status([file('a.test.ts', 'current', 'skip')])).state, 'pass');
});

test('an input that selects no test is named as missing', () => {
  const r = judgeSqueal(3, { ...status([]), selection: { testFiles: [], unmatched: ['src/x.ts'] } });
  assert.deepEqual([r.state, r.missing, r.unmatched], ['incomplete', [], ['src/x.ts']]);
  const [line] = squealLines(r, 1000);
  assert.equal(line.ok, false);
  assert.match(line.text, /src\/x\.ts\. Waiting does not change that: add a test .*`inputs`/);
  assert.doesNotMatch(line.text, /squeal status --wait/);
});

test('a setup failure fails the gate', () => {
  const r = judgeSqueal(3, { ...status([]), selection: { testFiles: [], verdict: { failures: { setups: 1 } } } });
  assert.equal(r.state, 'fail');
});

test('absent lint evidence is unfinished lint', () => {
  assert.equal(lintUnfinished(judgeSqueal(0, { selection: { testFiles: [] } }).lint), true);
});

test('lint that is off or failed is unfinished, not clean', () => {
  for (const reason of [{ off: 'no oxlint installed' }, { failed: 'could not key lint inputs' }, { unreadable: 'x' }]) {
    const lint = { files: 0, failing: 0, pending: 0, stale: 0, unknown: 0, linting: { done: 0, total: 0 }, ...reason };
    assert.equal(lintUnfinished(judgeSqueal(0, { selection: { testFiles: [] }, lint }).lint), true);
  }
});

test('lint that has not started is unfinished when a linted file changed', () => {
  const notStarted = { selection: { testFiles: [] }, lint: { failing: 0, linting: { done: 0, total: 0 } } };
  assert.equal(lintUnfinished(judgeSqueal(0, notStarted, () => false, true).lint), true);
  assert.equal(lintUnfinished(judgeSqueal(0, notStarted).lint), false);
});

test('finished lint omits the progress field and is clean', () => {
  const done = { selection: { testFiles: [] }, lint: { files: 2000, failing: 0, pending: 0, stale: 0, unknown: 0 } };
  const r = judgeSqueal(0, done, () => false, true);
  assert.deepEqual([r.state, lintUnfinished(r.lint)], ['pass', false]);
});

const ok = out => ({ code: 0, out, err: '' });
const live = (testFiles, lint) => JSON.stringify({ available: true, daemon: { state: 'alive' }, selection: { testFiles }, lint });
const doneLint = { failing: 0, pending: 0, stale: 0, unknown: 0 };

function fakeIo({ responses = {}, files = 'scripts/x.mjs\0', numstat = '1\t0\tscripts/x.mjs\0', nameStatus = 'M\0scripts/x.mjs\0', patch = 'diff --git a/scripts/x.mjs b/scripts/x.mjs\n+small\n', noBase = false, nodeTests = { argv: [], files: [] } } = {}) {
  const calls = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      const key = [cmd, args[0], args[1]].join(' ');
      const r = responses[key] ?? responses[cmd];
      return typeof r === 'function' ? r(args) : r ?? ok('');
    },
    nodeTests: () => nodeTests,
    git: (...a) => (a[0] === 'merge-base' ? (noBase ? '' : 'base123\n') : a[0] === 'diff' ? files : a[0] === 'status' ? '' : a[0] === 'rev-parse' ? 'abc1234\n' : ''),
    gitBytes: (...a) => Buffer.from(a.includes('--numstat') ? numstat : a.includes('--name-status') ? nameStatus : patch),
  };
}

test('squealChecks reports no daemon when squeal is missing or not alive', async () => {
  assert.deepEqual(await squealChecks(['a.ts'], 1000, fakeIo({ responses: { squeal: { code: 127, out: '', err: '' } } })), { daemon: false });
});

test('an unreadable squeal status is an unknown result that fails, not an absent daemon', async () => {
  const r = await squealChecks(['a.ts'], 1000, fakeIo({ responses: { squeal: { code: 143, out: 'not json', err: 'killed' } } }));
  assert.deepEqual([r.daemon, r.state, r.exit], [true, 'unreadable', 143]);
  const [line] = squealLines(r, 1000);
  assert.equal(line.ok, false);
  assert.match(line.text, /exited 143 without a readable result[^]*killed/);
  assert.deepEqual(await squealChecks(['a.ts'], 1000, fakeIo({ responses: { squeal: ok(JSON.stringify({ available: false })) } })), { daemon: false });
});

test('squealChecks returns a passing verdict from one wait', async () => {
  const io = fakeIo({ responses: { squeal: ok(live([file('a.test.ts', 'current', 'pass')], doneLint)) } });
  const r = await squealChecks(['a.ts'], 1000, io);
  assert.equal(r.state, 'pass');
  assert.deepEqual(io.calls[0].slice(0, 4), ['squeal', 'status', '--wait', '1000']);
});

test('squealChecks waits once and does not poll lint that has not finished', async () => {
  const io = fakeIo({ responses: { squeal: ok(live([], { failing: 0, linting: { done: 0, total: 0 } })) } });
  const r = await squealChecks(['packages/a/src/x.ts'], 10_000, io);
  assert.deepEqual([r.state, lintUnfinished(r.lint), io.calls.length], ['pass', true, 1]);
});

test('focusedTests skips a full or unreadable selection and runs a narrow one', async () => {
  const plan = out => fakeIo({ responses: { node: ok(out) } });
  assert.match((await focusedTests('b', plan('{"mode":"full"}'))).skipped, /full suite/);
  assert.equal((await focusedTests('b', plan('oops'))).code, 0);
  assert.match((await focusedTests('b', plan('{"mode":"skip"}'))).skipped, /no tests/);
  const io = plan('{"mode":"changed"}');
  assert.equal((await focusedTests('b', io)).code, 0);
  assert.deepEqual(io.calls.at(-1), ['node', 'scripts/test-changed.mjs', '--base=b']);
});

test('squealLines words each state', () => {
  const lint = { failing: 0, unfinished: 0 };
  assert.match(squealLines({ state: 'fail', failed: ['a.test.ts'], lint }, 1000)[0].text, /failing test files: a.test.ts/);
  assert.match(squealLines({ state: 'fail', failed: [], lint: { failing: 2 } }, 1000)[0].text, /2 lint finding/);
  assert.match(squealLines({ state: 'fail', failed: [], lint }, 1000)[0].text, /known test failures/);
  const missing = Array.from({ length: 12 }, (_, i) => `f${i}.test.ts`);
  const inc = squealLines({ state: 'incomplete', missing, lint: { unfinished: 3 } }, 120_000)[0];
  assert.equal(inc.ok, false);
  assert.match(inc.text, /^- FAIL: Squeal had no test result within 120 s for: f0\.test\.ts.*f9\.test\.ts, and 2 more\. .*squeal run run-loop/);
  assert.match(squealLines({ state: 'pass', count: 4, failed: [], missing: [], lint }, 1000)[0].text, /4 affected test file\(s\) current and passing; lint clean$/);
  assert.doesNotMatch(squealLines({ state: 'pass', count: 4, failed: [], missing: [], lint: { unfinished: 2 } }, 1000)[0].text, /lint clean/);
});

test('the lint fallback line names why it ran and carries the lint verdict', () => {
  const finding = lintFallbackLine({ unfinished: 2 }, { code: 1, out: 'packages/a/src/x.ts: no-unused-vars', err: '' });
  assert.equal(finding.ok, false);
  assert.match(finding.text, /^- FAIL: lint: Squeal's lint did not finish for 2 file\(s\), so prepr ran `npm run lint`\npackages\/a\/src\/x\.ts: no-unused-vars/);
  const clean = lintFallbackLine({ unfinished: 1, unavailable: 'no oxlint installed' }, ok(''));
  assert.deepEqual([clean.ok, clean.text], [true, "- pass: lint: Squeal's lint is unavailable (no oxlint installed), so prepr ran `npm run lint`"]);
});

test('a passing lint run keeps the baselines it lowered in the report, so the commit is not missed', () => {
  const out = 'lowered: packages/cezar/src/file-length.baseline.json: a.ts: pinned at 1500, now 1480. Commit the baseline\nlint: repository checks passed\n';
  assert.equal(loweredNotes(out), '\n  - lowered: packages/cezar/src/file-length.baseline.json: a.ts: pinned at 1500, now 1480. Commit the baseline');
  assert.equal(loweredNotes('lint: repository checks passed\n'), '');
  const clean = lintFallbackLine({ unfinished: 1 }, ok(out));
  assert.match(clean.text, /^- pass: lint: .+`npm run lint`\n  - lowered: packages\/cezar\/src\/file-length\.baseline\.json: a\.ts/);
});

test('fallbackLines runs focused tests, node:test readers and lint, and reports their failures', async () => {
  const io = fakeIo({ responses: { node: ok('{"mode":"changed"}'), npm: { code: 1, out: 'bad', err: '' } } });
  const lines = await fallbackLines('b', ['docs/x.md'], io);
  assert.match(lines[0].text, /No Squeal daemon/);
  assert.match(lines[2].text, /skipped: node:test readers/);
  assert.equal(lines[3].ok, false);
  assert.match(lines[3].text, /bad/);
});

test('fallbackLines runs the node:test readers that the changed paths select', async () => {
  const selected = { argv: ['--import', './scripts/test-home-env.mjs'], files: ['.github/scripts/a.workflow.test.cjs', '.github/scripts/auto-merge-gates.test.cjs'] };
  const io = fakeIo({ nodeTests: selected, responses: { node: args => (args.includes('--test') ? { code: 1, out: 'not ok 1', err: '' } : ok('{"mode":"skip"}')) } });
  const lines = await fallbackLines('b', ['.github/workflows/ci.yml'], io);
  assert.ok(io.calls.some(c => c.join(' ') === 'node --import ./scripts/test-home-env.mjs --test .github/scripts/a.workflow.test.cjs .github/scripts/auto-merge-gates.test.cjs'));
  assert.equal(lines[2].ok, false);
  assert.match(lines[2].text, /node:test readers of the changed paths \(2 file\(s\)\)\nnot ok 1/);
});

test('prepr passes on a clean change and skips typecheck for docs only', async () => {
  const clean = fakeIo({ responses: { squeal: ok(live([file('a.test.mjs', 'current', 'pass')], doneLint)) } });
  const r = await prepr({ io: clean, waitMs: 1000 });
  assert.equal(r.failed, false);
  assert.match(r.report, /^prepr: PASS/);
  assert.ok(clean.calls.some(c => c.includes('typecheck')));
  const docs = await prepr({ io: fakeIo({ files: 'docs/x.md\0', responses: { squeal: ok(live([], doneLint)) } }), waitMs: 1000 });
  assert.match(docs.report, /skipped: typecheck/);
});

test('prepr fails when a direct check fails, and with no daemon runs the fallback', async () => {
  const bad = fakeIo({ responses: { squeal: ok(live([], doneLint)), node: args => ({ code: args[0].includes('clones') ? 1 : 0, out: 'dup', err: '' }) } });
  const r = await prepr({ io: bad, waitMs: 1000 });
  assert.equal(r.failed, true);
  assert.match(r.report, /FAIL: clones\ndup/);
  const none = await prepr({ io: fakeIo({ responses: { squeal: { code: 127, out: '', err: '' }, node: ok('{"mode":"full"}') } }), waitMs: 1000 });
  assert.match(none.report, /No Squeal daemon/);
  const empty = await prepr({ io: fakeIo({ files: '' }), waitMs: 1000 });
  assert.match(empty.report, /0 changed file/);
});

test('prepr keeps unusual path names whole and fails on a missing base', async () => {
  const io = fakeIo({ files: 'docs/caf\u00e9\tx.md\0docs/y.md\0', responses: { squeal: ok(live([], doneLint)) } });
  await prepr({ io, waitMs: 1000 });
  assert.ok(io.calls[0].includes('docs/caf\u00e9\tx.md') || io.calls.some(c => c.includes('docs/caf\u00e9\tx.md')));
  await assert.rejects(prepr({ io: fakeIo({ noBase: true }), waitMs: 1000 }), /No merge base/);
});

test('squealChecks passes a process timeout to the wait', async () => {
  const io = fakeIo({ responses: { squeal: ok(live([], doneLint)) } });
  let options;
  const run = io.run;
  io.run = async (cmd, args, o) => { options ??= o; return run(cmd, args, o); };
  await squealChecks(['a.ts'], 1000, io);
  assert.equal(options.timeout, 11_000);
});

function fixtureRepo(t, write, seed = () => {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'prepr-patch-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const io = gitIo(cwd);
  for (const a of [['init', '-b', 'main'], ['config', 'user.name', 'Test'], ['config', 'user.email', 'test@example.invalid']]) io.git(...a);
  seed(cwd);
  for (const a of [['add', '--all'], ['commit', '--allow-empty', '-m', 'base'], ['switch', '-c', 'topic']]) io.git(...a);
  write(cwd, io);
  io.git('add', '--all');
  io.git('commit', '-m', 'head');
  return io;
}

const LINE = 'x'.repeat(99) + '\n';

test('patch limits refuse a file diff over the GitHub bound and a NUL byte, naming the file and the limit', async t => {
  const io = fixtureRepo(t, (cwd, git) => {
    // User settings that would make Git treat a large text file as binary and skip it.
    fs.writeFileSync(path.join(cwd, '.git', 'user-attributes'), '*.md binary\n*.txt -diff\n');
    for (const [key, value] of [['core.bigFileThreshold', '100k'], ['core.attributesFile', path.join(cwd, '.git', 'user-attributes')]]) git.git('config', key, value);
    fs.writeFileSync(path.join(cwd, 'large.md'), LINE.repeat(Math.ceil(GITHUB_PATCH_LIMITS.fileBytes / 100) + 10));
    // Git reads only the first 8000 bytes for binary detection, so this file stays text.
    fs.writeFileSync(path.join(cwd, 'nul.txt'), Buffer.concat([Buffer.from(LINE.repeat(100)), Buffer.from([0, 10])]));
    fs.writeFileSync(path.join(cwd, 'small.txt'), 'small\n');
    fs.writeFileSync(path.join(cwd, 'image.bin'), Buffer.alloc(GITHUB_PATCH_LIMITS.fileBytes * 2));
  });
  const lines = patchLimitLines('main', io);
  assert.ok(lines.every(l => !l.ok));
  const text = lines.map(l => l.text).join('\n');
  assert.match(text, new RegExp(`"large\\.md": its diff is \\d+ bytes, over GitHub's ${GITHUB_PATCH_LIMITS.fileBytes}-byte per-file patch limit`));
  assert.match(text, /"nul\.txt": its diff contains a NUL byte/);
  assert.doesNotMatch(text, /small\.txt|image\.bin/);
  assert.match(lines.at(-1).text, /FAIL: patch limits: 2 of 4 file diffs refused; \d+ changed lines \(\+\d+\/-0\) in 4 files/);
});

test('patch limits pass under the bound and print the total changed lines', async t => {
  const io = fixtureRepo(t, cwd => {
    fs.writeFileSync(path.join(cwd, 'a.md'), LINE.repeat(1000));
    fs.writeFileSync(path.join(cwd, 'b.md'), 'b\n');
  });
  const [line, ...rest] = patchLimitLines('main', io);
  assert.deepEqual(rest, []);
  assert.equal(line.ok, true);
  assert.match(line.text, new RegExp(`pass: patch limits: every non-deletion file diff is at most ${GITHUB_PATCH_LIMITS.fileBytes} bytes with no NUL byte; 1001 changed lines \\(\\+1001/-0\\) in 2 files`));
});

test('prepr fails on a patch-limit refusal', async () => {
  const io = fakeIo({ patch: 'diff --git a/scripts/x.mjs b/scripts/x.mjs\n+a\0b\n', responses: { squeal: ok(live([], doneLint)) } });
  const r = await prepr({ io, waitMs: 1000 });
  assert.equal(r.failed, true);
  assert.match(r.report, /FAIL: patch limits: "scripts\/x\.mjs": its diff contains a NUL byte/);
});

test('patch limits measure a renamed file by its rename patch, as GitHub does', async t => {
  const large = LINE.repeat(Math.ceil(GITHUB_PATCH_LIMITS.fileBytes / 100) + 10);
  const io = fixtureRepo(t, (cwd, git) => {
    // A user rename limit below the candidates would turn the edited rename into a delete and an add.
    git.git('config', 'diff.renameLimit', '1');
    fs.renameSync(path.join(cwd, 'moved.md'), path.join(cwd, 'dir moved.md'));
    fs.renameSync(path.join(cwd, 'edited.md'), path.join(cwd, 'edited-new.md'));
    fs.appendFileSync(path.join(cwd, 'edited-new.md'), 'one more line\n');
    fs.renameSync(path.join(cwd, 'second.md'), path.join(cwd, 'second-new.md'));
    fs.appendFileSync(path.join(cwd, 'second-new.md'), 'one more line\n');
  }, cwd => {
    fs.writeFileSync(path.join(cwd, 'moved.md'), large);
    fs.writeFileSync(path.join(cwd, 'edited.md'), large + 'edited\n');
    fs.writeFileSync(path.join(cwd, 'second.md'), large + 'second\n');
  });
  const [line, ...rest] = patchLimitLines('main', io);
  assert.deepEqual(rest, []);
  assert.equal(line.ok, true, line.text);
  assert.match(line.text, /2 changed lines \(\+2\/-0\) in 3 files/);
});

test('numstat rows keep tabs in a path and read a rename row as two paths', () => {
  assert.deepEqual(numstatRows('1200\t0\tdocs/large\tfile.md\0' + '3\t1\t\0old\tname.md\0new name.md\0' + '-\t-\tbin\0'), [
    { added: '1200', deleted: '0', paths: ['docs/large\tfile.md'] },
    { added: '3', deleted: '1', paths: ['old\tname.md', 'new name.md'] },
    { added: '-', deleted: '-', paths: ['bin'] },
  ]);
});

test('patch limits measure GitHub\'s patch shape, whatever the user\'s diff settings', async t => {
  const saved = { GIT_DIFF_OPTS: process.env.GIT_DIFF_OPTS, GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF };
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  process.env.GIT_DIFF_OPTS = '--unified=100000';
  process.env.GIT_EXTERNAL_DIFF = 'false';
  const io = fixtureRepo(t, (cwd, git) => {
    const settings = [['diff.context', '0'], ['diff.interHunkContext', '100000'], ['diff.noprefix', 'true'],
      ['color.diff', 'always'], ['diff.algorithm', 'patience'], ['diff.relative', 'true'], ['diff.suppressBlankEmpty', 'true']];
    for (const [key, value] of settings) git.git('config', key, value);
    const lines = LINE.repeat(Math.ceil(GITHUB_PATCH_LIMITS.fileBytes / 100) + 10).split('\n');
    lines[0] = 'first edited';
    lines[lines.length - 2] = 'last edited';
    fs.writeFileSync(path.join(cwd, 'big.md'), lines.join('\n'));
  }, cwd => fs.writeFileSync(path.join(cwd, 'big.md'), LINE.repeat(Math.ceil(GITHUB_PATCH_LIMITS.fileBytes / 100) + 10)));
  const [line] = patchLimitLines('main', io);
  assert.equal(line.ok, true, line.text);
});

test('patch limits read each path literally, so a glob character selects only its own file', async t => {
  const half = LINE.repeat(Math.ceil(GITHUB_PATCH_LIMITS.fileBytes / 200) + 10);
  const io = fixtureRepo(t, cwd => {
    fs.writeFileSync(path.join(cwd, 'a[1].txt'), half);
    fs.writeFileSync(path.join(cwd, 'a1.txt'), half);
  });
  const [line, ...rest] = patchLimitLines('main', io);
  assert.deepEqual(rest, []);
  assert.equal(line.ok, true, line.text);
});

test('a failed Git read stops prepr instead of reading as no change', async t => {
  const io = fixtureRepo(t, cwd => fs.writeFileSync(path.join(cwd, 'a.txt'), 'a\n'));
  assert.throws(() => io.gitBytes('diff', 'no-such-ref'), /git diff no-such-ref failed \(exit 128\)/);
});

test('patch limits measure a file replaced by a directory as separate patches', async t => {
  // Distinct lines, so Git pairs no two of the three files as a rename.
  const half = tag => Array.from({ length: Math.ceil(GITHUB_PATCH_LIMITS.fileBytes / 200) + 10 }, (_, i) => `${tag} ${i} `.padEnd(99, tag) + '\n').join('');
  const io = fixtureRepo(t, cwd => {
    fs.rmSync(path.join(cwd, 'foo'));
    fs.mkdirSync(path.join(cwd, 'foo'));
    fs.writeFileSync(path.join(cwd, 'foo', 'a.md'), half('a'));
    fs.writeFileSync(path.join(cwd, 'foo', 'b.md'), half('b'));
  }, cwd => fs.writeFileSync(path.join(cwd, 'foo'), half('x')));
  const [line, ...rest] = patchLimitLines('main', io);
  assert.deepEqual(rest, []);
  assert.equal(line.ok, true, line.text);
});

test('patch limits read a type change, which Git writes as two patch blocks for one file', async t => {
  const io = fixtureRepo(t, cwd => {
    fs.rmSync(path.join(cwd, 'link'));
    fs.writeFileSync(path.join(cwd, 'link'), 'now a file\n');
    fs.writeFileSync(path.join(cwd, 'after.md'), 'after\n');
  }, cwd => fs.symlinkSync('target', path.join(cwd, 'link')));
  const [line, ...rest] = patchLimitLines('main', io);
  assert.deepEqual(rest, []);
  assert.equal(line.ok, true, line.text);
  assert.match(line.text, /3 changed lines \(\+2\/-1\) in 2 files/);
});

for (const change of ['removed', 'modified', 'readded', 'renamed', 'deletion-only', 'removed-nul']) {
  test(`patch limits preserve the rule for oversized ${change} files`, t => {
    const large = LINE.repeat(Math.ceil(GITHUB_PATCH_LIMITS.fileBytes / 100) + 10);
    const io = fixtureRepo(t, (cwd, git) => {
      const file = path.join(cwd, 'large.txt');
      if (change === 'removed' || change === 'removed-nul') fs.unlinkSync(file);
      if (change === 'deletion-only') fs.writeFileSync(file, LINE);
      if (change === 'modified') fs.writeFileSync(file, 'changed\n'.repeat(20000));
      if (change === 'readded') {
        fs.unlinkSync(file);
        git.git('add', '--all');
        git.git('commit', '-m', 'delete');
        fs.writeFileSync(file, 'replacement\n'.repeat(20000));
      }
      if (change === 'renamed') {
        fs.renameSync(file, path.join(cwd, 'renamed.txt'));
        fs.appendFileSync(path.join(cwd, 'renamed.txt'), large.repeat(2));
      }
    }, cwd => fs.writeFileSync(path.join(cwd, 'large.txt'),
      change === 'renamed' ? large.repeat(4) : change === 'removed-nul' ? large + '\0\n' : large));
    if (change === 'deletion-only') {
      assert.match(io.git('diff', '--name-status', 'main', 'HEAD'), /^M/m);
      assert.match(io.git('diff', '--numstat', 'main', 'HEAD'), /^0\t/m);
    }
    if (change === 'renamed') assert.match(io.git('diff', '--name-status', '--find-renames', 'main', 'HEAD'), /^R/m);
    const lines = patchLimitLines('main', io);
    assert.equal(lines.every(line => line.ok), change === 'removed', lines.map(line => line.text).join('\n'));
  });
}


test('prepr fails on runner-only lint even when Squeal oxlint is clean', async () => {
  const io = fakeIo({ responses: {
    squeal: ok(live([], doneLint)),
    'node packages/cezar/src/lint/run.ts --repository-only': { code: 1, out: '', err: 'stale file-length pin' },
  } });
  const result = await prepr({ io, waitMs: 1000 });
  assert.equal(result.failed, true);
  assert.match(result.report, /FAIL: repository lint\nstale file-length pin/);
});

test('prepr runs repository lint for docs-only changes too', async () => {
  const io = fakeIo({ files: 'docs/x.md\0', responses: { squeal: ok(live([], doneLint)) } });
  const result = await prepr({ io, waitMs: 1000 });
  assert.equal(result.failed, false);
  assert.ok(io.calls.some(call => call[0] === 'node' && call[1] === 'packages/cezar/src/lint/run.ts' && call[2] === '--repository-only'));
});

test('the test budget counts as CI counts and reports the requirement without failing', async t => {
  const small = fixtureRepo(t, cwd => fs.writeFileSync(path.join(cwd, 'a.test.ts'), LINE.repeat(400)));
  assert.deepEqual(testBudgetLines('main', small), [{ ok: true, text: '- pass: test budget: +400 net test lines (+400/-0) in 1 file(s). At or under +400: no PR-body section or label needed. New test files: a.test.ts.' }]);
  const large = fixtureRepo(t, cwd => fs.writeFileSync(path.join(cwd, 'b.spec.ts'), LINE.repeat(1001)));
  const [line] = testBudgetLines('main', large);
  assert.equal(line.ok, true);
  assert.match(line.text, /^- note: test budget: \+1001 net test lines .*`## Test budget` section.*`test-budget` label/);
});

test('prepr prints the test budget line', async () => {
  const io = fakeIo({ numstat: '500\t0\tsrc/a.test.ts\0', responses: { squeal: ok(live([], doneLint)) } });
  const r = await prepr({ io, waitMs: 1000 });
  assert.match(r.report, /- note: test budget: \+500 net test lines/);
});

test('prepr fails on a missing test result and names the file', async () => {
  const io = fakeIo({ responses: { squeal: { code: 3, out: live([file('a.test.ts', 'pending')], doneLint), err: '' } } });
  const r = await prepr({ io, waitMs: 120_000 });
  assert.equal(r.failed, true);
  assert.match(r.report, /^prepr: FAIL/);
  assert.match(r.report, /- FAIL: Squeal had no test result within 120 s for: a\.test\.ts/);
});

test('prepr runs npm run lint when Squeal lint has not finished, and fails on its finding', async () => {
  const unfinished = { failing: 0, linting: { done: 0, total: 0 } };
  const run = npm => fakeIo({ files: 'packages/a/src/x.ts\0', responses: { squeal: ok(live([], unfinished)), npm: args => (args[2] === 'lint' ? npm : ok('')) } });
  const bad = run({ code: 1, out: 'packages/a/src/x.ts: no-unused-vars', err: '' });
  const r = await prepr({ io: bad, waitMs: 1000 });
  assert.equal(r.failed, true);
  assert.ok(bad.calls.some(c => c.join(' ') === 'npm run --silent lint'));
  assert.match(r.report, /FAIL: lint: Squeal's lint did not finish for 1 file\(s\), so prepr ran `npm run lint`\npackages\/a\/src\/x\.ts: no-unused-vars/);
  const clean = await prepr({ io: run(ok('')), waitMs: 1000 });
  assert.equal(clean.failed, false);
  assert.match(clean.report, /- pass: lint: Squeal's lint did not finish/);
});

test('prepr does not run npm run lint when Squeal lint finished', async () => {
  const io = fakeIo({ responses: { squeal: ok(live([], doneLint)) } });
  await prepr({ io, waitMs: 1000 });
  assert.ok(!io.calls.some(c => c.join(' ') === 'npm run --silent lint'));
});

const GATE = '.ai/skills/check-code-quality/scripts/complexity-gate.mjs';

test('prepr fails on complexity growth with the gate\'s own report', async () => {
  const io = fakeIo({ responses: {
    squeal: ok(live([], doneLint)),
    [`node ${GATE} --base`]: { code: 1, out: 'scripts/x.mjs: grow() complexity 23 (limit 20, was 18)', err: '' },
  } });
  const r = await prepr({ io, waitMs: 1000 });
  assert.equal(r.failed, true);
  assert.ok(io.calls.some(c => c.join(' ') === `node ${GATE} --base origin/main --head HEAD`));
  assert.match(r.report, /- FAIL: complexity\nscripts\/x\.mjs: grow\(\) complexity 23/);
});

test('complexityRun allows growth only when the open PR carries the baseline-growth label', async () => {
  const labels = (...names) => ok(JSON.stringify({ state: 'OPEN', labels: names.map(name => ({ name })) }));
  const gate = async gh => {
    const io = fakeIo({ responses: { gh } });
    const r = await complexityRun('origin/main', io);
    return [r.name, io.calls.at(-1).includes('--allow-growth')];
  };
  assert.deepEqual(await gate(labels('baseline-growth')), ['complexity (growth approved by the baseline-growth label)', true]);
  assert.deepEqual(await gate(labels('bug')), ['complexity', false]);
  assert.deepEqual(await gate(ok(JSON.stringify({ state: 'CLOSED', labels: [{ name: 'baseline-growth' }] }))), ['complexity', false]);
  assert.deepEqual(await gate({ code: 1, out: '', err: 'no pull requests found for branch' }), ['complexity', false]);
  assert.deepEqual(await gate({ code: 127, out: '', err: 'gh: not found' }), ['complexity', false]);
});

test('prepr fails on a spec without a status line', async () => {
  const io = fakeIo({ responses: {
    squeal: ok(live([], doneLint)),
    node: args => (args[0] === '.github/scripts/check-spec-status.cjs' ? { code: 1, out: '.ai/specs/2026-11-18-x.md: no Status: line', err: '' } : ok('')),
  } });
  const r = await prepr({ io, waitMs: 1000 });
  assert.equal(r.failed, true);
  assert.match(r.report, /- FAIL: spec statuses\n\.ai\/specs\/2026-11-18-x\.md: no Status: line/);
});

test('a selection Squeal has not listed or synced is incomplete, even with current cached files', () => {
  const unlisted = status([file('a.test.ts', 'current', 'pass')]);
  unlisted.selection.verdict.unlisted = true;
  const r = judgeSqueal(3, unlisted);
  assert.equal(r.state, 'incomplete');
  assert.match(r.missing[0], /test discovery: Squeal has not listed the test files of the current revision/);
  for (const reason of ['unlisted', 'unsynced']) {
    const none = status([file('a.test.ts', 'current', 'pass')]);
    Object.assign(none.selection, { result: 'none', reason });
    assert.equal(judgeSqueal(3, none).state, 'incomplete', reason);
  }
});

test('prepr keeps the whole complexity report, so the function headline survives a long point list', async () => {
  const points = Array.from({ length: 30 }, (_, i) => `  line ${i}: if`);
  const report = ['1 changed function is over the complexity limit of 20:', '', 'scripts/x.mjs:3 grow: complexity 23 (was 18)', ...points].join('\n');
  const io = fakeIo({ responses: { squeal: ok(live([], doneLint)), [`node ${GATE} --base`]: { code: 1, out: report, err: '' } } });
  const r = await prepr({ io, waitMs: 1000 });
  assert.match(r.report, /- FAIL: complexity\n1 changed function[^]*scripts\/x\.mjs:3 grow: complexity 23[^]*line 29: if/);
});

test('a failing Squeal result still names the files with no result and the unmatched paths', () => {
  const st = { ...status([file('a.test.ts', 'current', 'fail'), file('b.test.ts', 'pending')]) };
  st.selection.unmatched = ['src/x.ts'];
  const r = judgeSqueal(1, st);
  assert.deepEqual([r.state, r.missing, r.unmatched], ['fail', ['b.test.ts'], ['src/x.ts']]);
  const text = squealLines(r, 1000).map(l => l.text).join('\n');
  assert.match(text, /failing test files: a\.test\.ts[^]*no test result within 1 s for: b\.test\.ts[^]*select no test file: src\/x\.ts/);
  const lintFail = judgeSqueal(0, status([file('c.test.ts', 'pending')], { lint: { failing: 2 } }));
  assert.match(squealLines(lintFail, 1000).map(l => l.text).join('\n'), /2 lint finding[^]*for: c\.test\.ts/);
});

test('prepr reports an unreadable squeal status and runs npm run lint for the unknown lint result', async () => {
  const io = fakeIo({ responses: { squeal: { code: 143, out: 'not json', err: 'killed' } } });
  const r = await prepr({ io, waitMs: 1000 });
  assert.equal(r.failed, true);
  assert.match(r.report, /- FAIL: Squeal: `squeal status --wait` exited 143 without a readable result/);
  assert.match(r.report, /- pass: lint: Squeal's lint is unavailable \(squeal status was unreadable\), so prepr ran `npm run lint`/);
});
