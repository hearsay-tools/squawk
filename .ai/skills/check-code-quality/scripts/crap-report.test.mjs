import './test-support.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { analyzeSource } from './code-metrics.mjs';
import { crapScore, functionCoverage, runCrapReport, summaryMarkdown, warningLine } from './crap-report.mjs';

function repo(t, files) {
  const cwd = mkdtempSync(join(tmpdir(), 'cez-crap-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Crap Test');
  git('config', 'user.email', 'crap@example.invalid');
  const commit = changes => {
    for (const [path, source] of Object.entries(changes)) {
      mkdirSync(dirname(join(cwd, path)), { recursive: true });
      writeFileSync(join(cwd, path), source);
    }
    git('add', '-A');
    git('commit', '-qm', 'change');
    return git('rev-parse', 'HEAD');
  };
  return { cwd, commit, base: commit(files) };
}

/** An Istanbul entry with one statement per `[line, column, hits]`. */
const entry = statements => ({
  statementMap: Object.fromEntries(statements.map(([line, column], id) => [id, { start: { line, column }, end: { line, column: column + 1 } }])),
  s: Object.fromEntries(statements.map(([, , hits], id) => [id, hits])),
});

function run(f, head, coverage, extra = []) {
  writeFileSync(join(f.cwd, 'coverage.json'), JSON.stringify(coverage));
  let output = '', error = '';
  const code = runCrapReport(['--base', f.base, '--head', head, '--coverage', 'coverage.json', '--json', 'report.json', ...extra], {
    cwd: f.cwd, stdout: { write: text => { output += text; } }, stderr: { write: text => { error += text; } },
  });
  const report = code === 0 ? JSON.parse(readFileSync(join(f.cwd, 'report.json'), 'utf8')) : undefined;
  return { code, output, error, report };
}

const branchy = (name, points) =>
  `export function ${name}(x) {\n${'  if (x) { x++; }\n'.repeat(points)}  return x;\n}\n`;

test('CRAP is complexity squared times uncovered cubed, plus complexity', () => {
  assert.equal(crapScore(5, 1), 5);
  assert.equal(crapScore(5, 0), 30);
  assert.equal(crapScore(6, 0), 42);
  assert.equal(crapScore(4, 0.5), 16 * 0.125 + 4);
});

test('a function counts only the statements of its own body, not those of a nested function', () => {
  const source = 'export function outer(x) {\n  const inner = () => {\n    return 1;\n  };\n  return inner();\n}\n';
  const functions = analyzeSource(source, 'a.ts');
  const starts = [0, 0, ...[...source.matchAll(/\n/g)].map(match => match.index + 1)];
  const coverage = entry([[2, 2, 1], [3, 4, 0], [5, 2, 0]]);
  const outer = functions.find(fn => fn.name === 'outer');
  const inner = functions.find(fn => fn.name === 'inner');
  assert.equal(functionCoverage(outer, functions, coverage, starts), 0.5);
  assert.equal(functionCoverage(inner, functions, coverage, starts), 0);
  assert.equal(functionCoverage(outer, functions, entry([]), starts), null);
});

test('a changed function over 30 is reported with a warning, one at or under 30 passes, and the exit is 0', t => {
  const f = repo(t, { 'src/a.ts': 'export const keep = 1;\n' });
  // `hot`: complexity 6, nothing covered: CRAP 42. `cool`: complexity 5, nothing covered: CRAP 30, equal to the limit.
  const head = f.commit({ 'src/a.ts': `export const keep = 1;\n${branchy('hot', 5)}${branchy('cool', 4)}` });
  const statements = [];
  for (let line = 3; line <= 7; line++) statements.push([line, 2, 0]);
  statements.push([8, 2, 0]);
  for (let line = 11; line <= 14; line++) statements.push([line, 2, 0]);
  statements.push([15, 2, 0]);
  const result = run(f, head, { 'src/a.ts': entry(statements) });
  assert.equal(result.code, 0, result.error);
  const byName = Object.fromEntries(result.report.functions.map(fn => [fn.name, fn]));
  assert.equal(byName.hot.status, 'over');
  assert.equal(byName.hot.crap, 42);
  assert.equal(byName.hot.coverage, 0);
  assert.equal(byName.cool.status, 'pass');
  assert.equal(byName.cool.crap, 30);
  assert.match(result.output, /^::warning file=src\/a\.ts,line=2,title=CRAP over 30::hot: CRAP 42\.0 \(complexity 6, coverage 0%25; limit 30\)$/m);
  assert.doesNotMatch(result.output, /::warning.*cool/);
});

test('a covered function passes, a file missing from the report has no coverage data, and an excluded file is skipped', t => {
  const f = repo(t, { 'src/a.ts': 'export const keep = 1;\n', 'squeal.config.json': JSON.stringify({ coverage: { exclude: ['scripts/mock-*.mjs'] } }) });
  const head = f.commit({
    'src/a.ts': `export const keep = 1;\n${branchy('covered', 5)}`,
    'src/b.ts': branchy('unloaded', 5),
    'scripts/mock-child.mjs': branchy('child', 5),
  });
  const statements = [3, 4, 5, 6, 7, 8].map(line => [line, 2, 1]);
  const result = run(f, head, { 'src/a.ts': entry(statements) }, ['--exclude-config', 'squeal.config.json']);
  assert.equal(result.code, 0, result.error);
  const byName = Object.fromEntries(result.report.functions.map(fn => [fn.name, fn]));
  assert.deepEqual([byName.covered.status, byName.covered.crap, byName.covered.coverage], ['pass', 6, 1]);
  assert.equal(byName.unloaded.status, 'no-coverage');
  assert.equal(byName.unloaded.crap, null);
  assert.equal(byName.child.status, 'excluded');
  assert.doesNotMatch(result.output, /::warning/);
});

test('a row names its scope, so same-named nested functions stay apart', t => {
  const f = repo(t, { 'src/a.ts': 'export const keep = 1;\n' });
  const head = f.commit({ 'src/a.ts': 'export const keep = 1;\nexport function build() {\n  const helper = () => 1;\n  return helper();\n}\nexport function parse() {\n  const helper = () => 2;\n  return helper();\n}\n' });
  const result = run(f, head, { 'src/a.ts': entry([[3, 2, 1], [3, 23, 1], [4, 2, 1], [7, 2, 1], [7, 23, 0], [8, 2, 1]]) });
  assert.equal(result.code, 0, result.error);
  const scopes = result.report.functions.map(fn => fn.scope).sort();
  assert.deepEqual(scopes, ['build', 'build / helper', 'parse', 'parse / helper']);
});

test('missing arguments or an unreadable coverage file exit 2', t => {
  const f = repo(t, { 'a.ts': 'export const a = 1;\n' });
  assert.equal(runCrapReport(['--base', f.base], { cwd: f.cwd, stdout: { write() {} }, stderr: { write() {} } }), 2);
  let error = '';
  const code = runCrapReport(['--base', f.base, '--head', f.base, '--coverage', 'absent.json'], {
    cwd: f.cwd, stdout: { write() {} }, stderr: { write: text => { error += text; } },
  });
  assert.equal(code, 2);
  assert.match(error, /^crap-report: /);
});

test('the summary lists functions over the limit first and escapes table cells', () => {
  const markdown = summaryMarkdown({
    head: 'abc', limit: 30, coverageArtifact: 'vitest-coverage-abc',
    functions: [
      { file: 'a.ts', name: 'ok', line: 1, complexity: 2, coverage: 1, crap: 2, status: 'pass' },
      { file: 'a.ts', name: 'a|b', line: 9, complexity: 8, coverage: 0.1, crap: 54.6, status: 'over' },
    ],
  });
  const rows = markdown.split('\n').filter(line => line.startsWith('| `'));
  assert.match(rows[0], /^\| `a\.ts:9` a\\\|b \| 8 \| 10% \| 54\.6 \| over the limit \|$/);
  assert.match(rows[1], /ok \| 2 \| 100% \| 2\.0 \| pass/);
  assert.match(markdown, /2 changed functions; 1 over 30/);
  assert.match(markdown, /`vitest-coverage-abc`, tested commit `abc`/);
});

test('a warning escapes the annotation properties', () => {
  assert.equal(
    warningLine({ file: 'a,b:c.ts', line: 3, name: 'f', complexity: 6, coverage: 0, crap: 42 }, 30),
    '::warning file=a%2Cb%3Ac.ts,line=3,title=CRAP over 30::f: CRAP 42.0 (complexity 6, coverage 0%25; limit 30)',
  );
});
