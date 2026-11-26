import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyEdit, buildBreak, listRecipes, parseArgs, ProofError, recipeProblems, summarize, validateRecipe } from './regression-proof.mjs';

const script = fileURLToPath(new URL('./regression-proof.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'regression-proof-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const put = (path, text) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  put('src/guard.ts', 'export function guard() {\n  return true;\n}\n');
  put('src/guard.test.ts', 'test\n');
  git('add', '.');
  git('commit', '-m', 'base');
  return { cwd, git, put };
}

/** A fake `squeal` on PATH that records its arguments and prints `report` with `status`. */
function fakeSqueal(t, report, status = 0) {
  const bin = mkdtempSync(join(tmpdir(), 'regression-proof-bin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, 'report.json'), JSON.stringify(report));
  // The report's base reads __BASE__ until the fake fills in the --base it was given.
  writeFileSync(join(bin, 'squeal'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args"\nbase=; prev=\nfor arg in "$@"; do [ "$prev" = --base ] && base=$arg; prev=$arg; done\nsed "s/__BASE__/$base/g" "${bin}/report.json"\nexit ${status}\n`);
  chmodSync(join(bin, 'squeal'), 0o755);
  return { bin, args: () => readFileSync(join(bin, 'args'), 'utf8').trim().split('\n') };
}

// A PATH with git but without the host's squeal, for the run that has no squeal.
const gitOnly = dirname(execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim());

function run(cwd, args, bin) {
  const PATH = bin ? `${bin}${delimiter}${process.env.PATH}` : gitOnly;
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env: { ...process.env, PATH } });
}

function proofReport(base, head, verdicts) {
  return {
    version: 'squeal-proof/1', base, head,
    files: verdicts.map(([path, verdict, failures = []]) => ({
      path, verdict, reason: null,
      red: { end: failures.length ? 'fail' : 'pass', failures: failures.map(name => ({ test: name, kind: 'assertion' })) },
      green: { end: 'pass', failures: [] },
    })),
  };
}

const recipe = {
  name: 'guard-false', description: 'guard returns false', fixedBy: 'abcdef1',
  break: [{ file: 'src/guard.ts', find: '  return true;', replace: '  return false;' }],
  tests: ['src/guard.test.ts'],
};

test('a recipe break becomes a commit over HEAD and leaves the work tree, index and branch alone', (t) => {
  const { cwd, git } = fixture(t);
  const head = git('rev-parse', 'HEAD');
  const commit = buildBreak(cwd, { recipe, label: recipe.name });
  assert.equal(git('rev-parse', `${commit}^`), head);
  assert.equal(git('show', `${commit}:src/guard.ts`), 'export function guard() {\n  return false;\n}');
  assert.equal(git('diff', '--name-only', head, commit), 'src/guard.ts');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(readFileSync(join(cwd, 'src/guard.ts'), 'utf8'), 'export function guard() {\n  return true;\n}\n');
});

test('a break keeps the file\'s final newline and mode', (t) => {
  const { cwd, git, put } = fixture(t);
  put('bin/tool.sh', '#!/bin/sh\nexit 0\n');
  chmodSync(join(cwd, 'bin/tool.sh'), 0o755);
  git('add', '.');
  git('commit', '-m', 'tool');
  const commit = buildBreak(cwd, { recipe: { ...recipe, break: [{ file: 'bin/tool.sh', find: 'exit 0', replace: 'exit 1' }] }, label: 'tool' });
  assert.match(git('ls-tree', commit, '--', 'bin/tool.sh'), /^100755 /);
  assert.equal(execFileSync('git', ['cat-file', 'blob', `${commit}:bin/tool.sh`], { cwd, encoding: 'utf8' }), '#!/bin/sh\nexit 1\n');
});

test('several edits to one file all reach the break commit, in recipe order', (t) => {
  const { cwd, git, put } = fixture(t);
  put('src/flags.ts', 'export const first = true;\nexport const second = true;\n');
  git('add', '.');
  git('commit', '-m', 'flags');
  const edits = [
    { file: 'src/flags.ts', find: 'first = true', replace: 'first = false' },
    { file: 'src/flags.ts', find: 'second = true', replace: 'second = false' },
    { file: 'src/flags.ts', find: 'first = false', replace: 'first = null' },
  ];
  const twoEdits = { ...recipe, break: edits };
  const commit = buildBreak(cwd, { recipe: twoEdits, label: 'flags' });
  assert.equal(git('show', `${commit}:src/flags.ts`), 'export const first = null;\nexport const second = false;');
  const read = (file) => readFileSync(join(cwd, file), 'utf8');
  assert.deepEqual(recipeProblems({ ...twoEdits, tests: ['src/guard.test.ts'] }, read), []);
  assert.match(recipeProblems({ ...twoEdits, break: [...edits, edits[0]], tests: ['src/guard.test.ts'] }, read)[0], /occurs 0 times/);
});

test('a break text found zero or two times is refused', () => {
  assert.throws(() => applyEdit('a\n', { file: 'f', find: 'b', replace: 'c' }), /occurs 0 times/);
  assert.throws(() => applyEdit('b b\n', { file: 'f', find: 'b', replace: 'c' }), /occurs 2 times/);
  assert.equal(applyEdit('a $& b\n', { file: 'f', find: 'b', replace: '$&$&' }), 'a $& $&$&\n');
});

test('--revert builds HEAD without the named commit, and refuses a revert that conflicts', (t) => {
  const { cwd, git, put } = fixture(t);
  put('src/guard.ts', 'export function guard() {\n  return check();\n}\n');
  git('commit', '-am', 'fix');
  const fix = git('rev-parse', 'HEAD');
  put('src/other.ts', 'export {};\n');
  git('add', '.');
  git('commit', '-m', 'later');
  const commit = buildBreak(cwd, { revert: fix, label: 'revert' });
  assert.equal(git('show', `${commit}:src/guard.ts`), 'export function guard() {\n  return true;\n}');
  assert.equal(git('show', `${commit}:src/other.ts`), 'export {};');
  put('src/guard.ts', 'export function guard() {\n  return check() && ready();\n}\n');
  git('commit', '-am', 'rewrite');
  assert.throws(() => buildBreak(cwd, { revert: fix, label: 'revert' }), /conflicts/);
});

test('--patch applies a patch file to the break commit only', (t) => {
  const { cwd, git, put } = fixture(t);
  put('src/guard.ts', 'export function guard() {\n  return false;\n}\n');
  writeFileSync(join(cwd, 'break.patch'), execFileSync('git', ['diff'], { cwd, encoding: 'utf8' }));
  git('checkout', '--', 'src/guard.ts');
  const commit = buildBreak(cwd, { patch: join(cwd, 'break.patch'), label: 'patch' });
  assert.match(git('show', `${commit}:src/guard.ts`), /return false/);
  assert.match(readFileSync(join(cwd, 'src/guard.ts'), 'utf8'), /return true/);
  writeFileSync(join(cwd, 'bad.patch'), 'not a patch\n');
  assert.throws(() => buildBreak(cwd, { patch: join(cwd, 'bad.patch'), label: 'bad' }), ProofError);
});

test('the CLI passes the break and the tests to squeal proof, prints the counts and returns its exit code', (t) => {
  const { cwd, git, put } = fixture(t);
  put('src/guard.ts', 'export function guard() {\n  return check();\n}\n');
  git('commit', '-am', 'fix');
  const fix = git('rev-parse', 'HEAD');
  const report = proofReport('__BASE__', fix, [['src/guard.test.ts', 'proven', ['guard rejects', 'guard rejects twice']]]);
  const squeal = fakeSqueal(t, report);
  const result = run(cwd, ['--revert', fix, '--test', 'src/guard.test.ts', '--timeout', '90'], squeal.bin);
  assert.equal(result.status, 0, result.stderr);
  const args = squeal.args();
  assert.deepEqual([args[0], args[1], args[2]], ['proof', 'src/guard.test.ts', '--base']);
  assert.equal(git('rev-parse', `${args[3]}^`), fix);
  assert.deepEqual(args.slice(4), ['--case', 'source', '--source', 'src/guard.ts', '--env', 'SQUAWK_REGRESSION_PROOF=1', '--json', '--timeout', '90']);
  assert.match(result.stdout, /proven: src\/guard\.test\.ts\n {4}red: fail, 2 failing tests; green: pass\n {6}assertion: guard rejects\n/);
  assert.match(result.stdout, /proven 1\/1$/m);
  const notRed = fakeSqueal(t, proofReport('__BASE__', fix, [['src/guard.test.ts', 'not red']]), 1);
  const second = run(cwd, ['--revert', fix, '--test', 'src/guard.test.ts'], notRed.bin);
  assert.equal(second.status, 1);
  assert.match(second.stdout, /red: pass; green: pass\nproven 0\/1/);
});

// A break never changes the test, so Squeal compares nothing until every file the break
// changes is named; a runtime-read or spawned file counts the same as an imported one.
// Squeal takes a --with file from HEAD on both sides, so a changed fixture or helper stays test code.
test('the CLI names product files the break changes as --source, test-side files as --with, and no named test', (t) => {
  const { cwd, git, put } = fixture(t);
  put('scripts/reader.sh', 'echo ok\n');
  put('src/fixtures/data.json', '{}\n');
  put('src/helper.spec.ts', 'helper\n');
  git('add', '.');
  git('commit', '-m', 'reader');
  put('scripts/reader.sh', 'echo broken\n');
  put('src/guard.ts', 'export function guard() {\n  return false;\n}\n');
  put('src/guard.test.ts', 'test changed\n');
  put('src/fixtures/data.json', '[]\n');
  put('src/helper.spec.ts', 'helper changed\n');
  writeFileSync(join(cwd, 'break.patch'), execFileSync('git', ['diff'], { cwd, encoding: 'utf8' }));
  git('checkout', '--', '.');
  const squeal = fakeSqueal(t, proofReport('__BASE__', git('rev-parse', 'HEAD'), [['src/guard.test.ts', 'proven', ['x']]]));
  const result = run(cwd, ['--patch', join(cwd, 'break.patch'), '--test', './src/guard.test.ts'], squeal.bin);
  assert.equal(result.status, 0, result.stderr);
  const args = squeal.args();
  const named = (flag) => args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
  assert.equal(args[1], 'src/guard.test.ts');
  assert.deepEqual(named('--source'), ['scripts/reader.sh', 'src/guard.ts']);
  assert.deepEqual(named('--with'), ['src/fixtures/data.json', 'src/helper.spec.ts']);
  assert.ok(args.includes('SQUAWK_REGRESSION_PROOF=1'));
});

test('a break that deletes or renames a file names the old and the new path as --source', (t) => {
  const { cwd, git, put } = fixture(t);
  put('scripts/old-name.sh', 'echo old\n');
  put('scripts/gone.sh', 'echo gone\n');
  git('add', '.');
  git('commit', '-m', 'scripts');
  git('mv', 'scripts/old-name.sh', 'scripts/new-name.sh');
  git('rm', '-q', 'scripts/gone.sh');
  writeFileSync(join(cwd, 'break.patch'), execFileSync('git', ['diff', '--cached', '-M'], { cwd, encoding: 'utf8' }));
  git('reset', '-q', '--hard');
  const squeal = fakeSqueal(t, proofReport('__BASE__', git('rev-parse', 'HEAD'), [['src/guard.test.ts', 'proven', ['x']]]));
  const result = run(cwd, ['--patch', join(cwd, 'break.patch'), '--test', 'src/guard.test.ts'], squeal.bin);
  assert.equal(result.status, 0, result.stderr);
  const args = squeal.args();
  const sources = args.flatMap((arg, index) => (args[index - 1] === '--source' ? [arg] : []));
  assert.deepEqual(sources, ['scripts/gone.sh', 'scripts/new-name.sh', 'scripts/old-name.sh']);
  assert.equal(args.includes('--with'), false);
});

test('the break is built over the pinned head, and a proof over another HEAD is refused', (t) => {
  const { cwd, git, put } = fixture(t);
  const pinned = git('rev-parse', 'HEAD');
  put('src/guard.ts', 'export function guard() {\n  return true; // later\n}\n');
  put('src/later.ts', 'export {};\n');
  git('add', '.');
  git('commit', '-m', 'autosave');
  const commit = buildBreak(cwd, { recipe, label: recipe.name }, pinned);
  assert.equal(git('rev-parse', `${commit}^`), pinned);
  assert.equal(git('show', `${commit}:src/guard.ts`), 'export function guard() {\n  return false;\n}');
  assert.equal(git('ls-tree', '--name-only', commit, '--', 'src/later.ts'), '');
  put('src/guard.ts', 'export function guard() {\n  return check();\n}\n');
  git('commit', '-am', 'fix');
  const fix = git('rev-parse', 'HEAD');
  const squeal = fakeSqueal(t, proofReport('__BASE__', 'c'.repeat(40), [['src/guard.test.ts', 'proven', ['x']]]));
  const moved = run(cwd, ['--revert', fix, '--test', 'src/guard.test.ts'], squeal.bin);
  assert.equal(moved.status, 2);
  assert.match(moved.stderr, /HEAD moved from .* during the proof/);
});

test('the CLI exits 2 without squeal, on a break that does not apply, and on bad arguments', (t) => {
  const { cwd, git, put } = fixture(t);
  const root = git('rev-parse', 'HEAD');
  put('src/guard.ts', 'export function guard() {\n  return check();\n}\n');
  git('commit', '-am', 'fix');
  const noSqueal = run(cwd, ['--revert', git('rev-parse', 'HEAD'), '--test', 'src/guard.test.ts']);
  assert.equal(noSqueal.status, 2);
  assert.match(noSqueal.stderr, /no squeal command on PATH/);
  const squeal = fakeSqueal(t, proofReport('b', 'c', []));
  const rootCommit = run(cwd, ['--revert', root, '--test', 'src/guard.test.ts'], squeal.bin);
  assert.equal(rootCommit.status, 2);
  assert.match(rootCommit.stderr, /has 0 parents/);
  assert.equal(existsSync(join(squeal.bin, 'args')), false);
  for (const [args, message] of [
    [['--revert', 'HEAD'], /needs at least one --test/],
    [['held-human-input', '--test', 'x'], /names its own tests/],
    [['a', 'b'], /choose one of/],
    [['--timeout', 'soon', 'a'], /whole seconds/],
    [['--bogus'], /unknown option/],
  ]) assert.throws(() => parseArgs(args), message);
});

test('summarize names files without a red side and failures past five, and drops only Squeal\'s control reason', () => {
  const report = proofReport('a'.repeat(40), 'b'.repeat(40), [['x.test.ts', 'proven', ['1', '2', '3', '4', '5', '6', '7']]]);
  report.files[0].reason = 'red without the conditions too: the conditions are not shown to matter';
  report.files.push({ path: 'y.test.ts', verdict: 'not comparable', reason: 'imports z.ts, absent at base', red: null, green: null });
  report.files.push({ path: 'z.e2e.ts', verdict: 'red for another reason', reason: 'a test threw an error that is not an assertion',
    red: { end: 'fail', failures: [{ test: 'shows the state', kind: 'error', text: '  Error: predicate never became truthy: ok\n    at wait' }] }, green: null });
  const text = summarize(report, 'demo');
  assert.match(text, /error: shows the state\n {8}Error: predicate never became truthy: ok\n/);
  assert.doesNotMatch(text, /at wait/);
  assert.match(text, /… and 2 more/);
  assert.match(text, /red: not read; green: not read\n {4}reason: imports z\.ts, absent at base/);
  assert.doesNotMatch(text, /conditions are not shown to matter/);
  report.files[0].reason = 'labelled on an error the test body threw; red without the conditions too: the conditions are not shown to matter';
  const thrown = summarize(report, 'demo');
  assert.match(thrown, /reason: labelled on an error the test body threw\n/);
  assert.doesNotMatch(thrown, /conditions are not shown to matter/);
  assert.match(text, /proven 1\/3$/);
});

test('a recipe without its fields is refused', () => {
  assert.throws(() => validateRecipe({ ...recipe, description: '' }, 'x'), /description/);
  assert.throws(() => validateRecipe({ ...recipe, fixedBy: 'HEAD' }, 'x'), /fixedBy/);
  assert.throws(() => validateRecipe({ ...recipe, break: [] }, 'x'), /break entry/);
  assert.throws(() => validateRecipe({ ...recipe, break: [{ file: 'f', find: 'a', replace: 'a' }] }, 'x'), /are equal/);
  assert.throws(() => validateRecipe({ ...recipe, tests: [] }, 'x'), /test files/);
});

// The checked-in recipes must still apply: a rename, a split test file or a rewritten line
// fails here, in the change that causes it, not in the next proof that needs the recipe.
test('every checked-in recipe applies to the current tree and names existing test files', () => {
  const recipes = listRecipes();
  assert.ok(recipes.length >= 3);
  const read = (file) => {
    const path = join(repoRoot, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
  assert.deepEqual(recipes.flatMap(entry => recipeProblems(entry, read)), []);
});
