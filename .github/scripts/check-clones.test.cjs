const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const script = path.join(__dirname, 'check-clones.cjs');

test('existing clones pass; an added clone fails and prints both source locations', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-proof-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), content); };
  const scan = (base) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
  const code = Array.from({ length: 12 }, (_, i) => `  total += values[${i}] * ${i + 37};`).join('\n');
  const source = (comment) => `export function calculate(values: number[]) {\n let total = 0;\n // ${comment}\n${code}\n return total;\n}\n`;
  try {
    git('init', '--quiet');
    write('packages/demo/src/first.ts', source('weights rows by position'));
    write('packages/demo/src/second.ts', source('weights rows by position'));
    git('add', '.'); git('commit', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');
    // hearsay-tools/squawk#1888: jscpd counts no comment tokens, so a comment edit inside a clone keeps its pair total.
    write('packages/demo/src/second.ts', source('weights each row by its position in the list'));
    git('add', '.'); git('commit', '-qm', 'comment edit');
    const existing = scan(base);
    assert.equal(existing.status, 0, existing.stdout + existing.stderr);
    t.diagnostic("existing baseline clones with an edited comment: exit 0");
    write('packages/demo/src/third.ts', fs.readFileSync(path.join(repo, 'packages/demo/src/first.ts')));
    git('add', '.'); git('commit', '-qm', 'clone');
    const failure = scan(base);
    assert.equal(failure.status, 1, failure.stdout + failure.stderr);
    assert.match(failure.stdout, /packages\/demo\/src\/first\.ts/);
    assert.match(failure.stdout, /packages\/demo\/src\/third\.ts/);
    t.diagnostic("added clone: exit 1; " + failure.stdout.split("\n").filter(line => /(?:first|third)\.ts/.test(line)).join("; "));
    write('packages/demo/src/third.ts', '// jscpd:ignore-start -- deliberate test example\n' + fs.readFileSync(path.join(repo, 'packages/demo/src/first.ts')) + '// jscpd:ignore-end\n');
    git('add', '.'); git('commit', '-qm', 'reasoned exception');
    assert.equal(scan(base).status, 0);
    fs.unlinkSync(path.join(repo, 'packages/demo/src/third.ts'));
    for (const name of ['ignored.test.ts', 'ignored.testkit.ts', 'ignored.e2e.ts', 'fixtures/example.ts']) {
      write(`packages/demo/src/${name}`, fs.readFileSync(path.join(repo, 'packages/demo/src/first.ts')));
    }
    write('.jscpd.json', '{"minTokens":1000000000}');
    write('.gitignore', 'packages/\n');
    git('add', '-f', '.'); git('commit', '-qm', 'excluded copies');
    assert.equal(scan(base).status, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// hearsay-tools/cezarion#1813: a baseline cannot grandfather a second package's copy.
test('cross-package clones fail even when already in the baseline', (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-package-clone-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), content); };
  const scan = (base) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
  const code = `export function calculate(values: number[]) {\n let total = 0;\n${Array.from({ length: 12 }, (_, i) => ` total += values[${i}] * ${i + 37};`).join('\n')}\n return total;\n}\n`;
  try {
    git('init', '--quiet');
    write('packages/contract/src/shared.ts', code);
    // A same-package baseline clone must stay allowed.
    write('packages/contract/src/other.ts', code);
    git('add', '.'); git('commit', '-qm', 'same-package baseline');
    const initial = git('rev-parse', 'HEAD');
    assert.equal(scan(initial).status, 0);
    write('packages/web/src/copied.ts', code);
    git('add', '.'); git('commit', '-qm', 'planted cross-package clone');
    for (const base of ['HEAD', initial]) {
      const failure = scan(base);
      assert.equal(failure.status, 1, `base ${base}: ${failure.stdout}${failure.stderr}`);
      assert.match(failure.stdout, /Cross-package clone/);
      assert.match(failure.stdout, /packages\/contract\/src\/(?:shared|other)\.ts:\d+/);
      assert.match(failure.stdout, /packages\/web\/src\/copied\.ts:\d+/);
    }
    t.diagnostic('planted cross-package clone rejected both as new code and as baseline code');
    fs.unlinkSync(path.join(repo, 'packages/web/src/copied.ts'));
    for (const name of ['ignored.test.ts', 'ignored.testkit.ts', 'ignored.e2e.ts', 'fixtures/example.ts']) {
      write(`packages/web/src/${name}`, code);
    }
    git('add', '.'); git('commit', '-qm', 'only excluded cross-package copies');
    assert.equal(scan('HEAD').status, 0);
    // A candidate cannot weaken the trusted report configuration.
    write('packages/web/src/copied.ts', code);
    write('.jscpd.json', '{"minTokens":1000000000}');
    write('.gitignore', 'packages/\n');
    git('add', '-f', '.'); git('commit', '-qm', 'candidate attempts to hide copy');
    assert.equal(scan('HEAD').status, 1);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

// hearsay-tools/cezarion#2135: shrinking an inherited pair can change every fingerprint.
test('recut cross-file clones pass within the inherited token ceiling', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-recut-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const folder = path.join(repo, 'packages/demo/src');
  const code = `export function calculate(values: number[]) {\n let total = 0;\n${Array.from({ length: 30 }, (_, i) => ` total += values[${i}] * ${i + 37};`).join('\n')}\n return total;\n}\n`;
  const scan = (base) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '--quiet'); fs.mkdirSync(folder, { recursive: true });
    for (const name of ['first.ts', 'second.ts']) fs.writeFileSync(path.join(folder, name), code);
    git('add', '.'); git('commit', '-qm', 'baseline');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(folder, 'second.ts'), code.replace(' total += values[15] * 52;', ' total = uniqueBoundary(total);'));
    git('add', '.'); git('commit', '-qm', 'recut inherited clone');
    const recut = scan(base);
    assert.equal(recut.status, 0, recut.stdout + recut.stderr);
    // Growing the original pair must fail even without introducing a third file.
    const grown = code.replace(' return total;', ' total += values[100] * 137;\n return total;');
    for (const name of ['first.ts', 'second.ts']) fs.writeFileSync(path.join(folder, name), grown);
    git('add', '.'); git('commit', '-qm', 'grow inherited clone');
    const growth = scan(base);
    assert.equal(growth.status, 1, growth.stdout + growth.stderr);
    assert.match(growth.stdout, /tokens/);
    // Uncommitted edits cannot change the measured result.
    fs.writeFileSync(path.join(folder, 'second.ts'), 'export const unique = 1;\n');
    assert.equal(scan(base).status, 1);
    git('add', '.'); git('commit', '-qm', 'remove pair');
    assert.equal(scan(base).status, 0);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

const { summarize, compare } = require('./check-clones.cjs');
const reportRoot = path.join(os.tmpdir(), 'clone-report-root');
function reportedClone(first, second, tokens, isNew = true) {
  return { firstFile: { name: path.join(reportRoot, first), start: 1 }, secondFile: { name: path.join(reportRoot, second), start: 10 }, tokens, isNew };
}

test('pair totals are unordered and cannot borrow allowance from another pair', () => {
  const a = 'packages/demo/src/a.ts'; const b = 'packages/demo/src/b.ts'; const c = 'packages/demo/src/c.ts';
  const summary = (clones) => summarize(reportRoot, clones);
  const base = summary([reportedClone(a, b, 200), reportedClone(a, c, 200)]);
  assert.deepEqual(compare(base, summary([reportedClone(b, a, 80), reportedClone(a, b, 120)])), []);
  assert.deepEqual(compare(base, summary([])), []);
  const failures = compare(base, summary([reportedClone(a, b, 201), reportedClone(a, c, 50)]));
  assert.equal(failures.length, 1);
  assert.match(failures[0], /baseline 200, head 201 tokens/);
  assert.equal(compare(base, summary([reportedClone(b, c, 50)])).length, 1);
});

test('report validation and same-file and cross-package policies fail closed', () => {
  const a = 'packages/demo/src/a.ts'; const b = 'packages/other/src/b.ts';
  const summary = (clones) => summarize(reportRoot, clones);
  const base = summary([]);
  assert.match(compare(base, summary([reportedClone(a, a, 100, false)]))[0], /New same-file clone/);
  assert.match(compare(base, summary([reportedClone(a, a, 100)]))[0], /New same-file clone/);
  assert.match(compare(base, summary([reportedClone(a, b, 100, false)]))[0], /Cross-package clone/);
  for (const tokens of [undefined, NaN, -1, 0, 1.5]) assert.throws(() => summary([reportedClone(a, a, tokens)]), /Invalid clone accounting/);
  assert.throws(() => summary([reportedClone('../outside.ts', a, 100)]), /outside the scanned packages/);
  const bad = reportedClone(a, a, 100); bad.firstFile.start = 0;
  assert.throws(() => summary([bad]), /Invalid clone location/);
});

test('same-file token ceilings and empty committed trees retain their policy', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-self-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const scan = (base) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
  const folder = path.join(repo, 'packages/demo/src');
  const code = `export function calculate(values: number[]) {\n let total = 0;\n${Array.from({ length: 30 }, (_, i) => ` total += values[${i}] * ${i + 37};`).join('\n')}\n return total;\n}\n`;
  try {
    git('init', '--quiet'); git('commit', '--allow-empty', '-qm', 'empty baseline');
    const empty = git('rev-parse', 'HEAD');
    const emptyScan = scan(empty);
    assert.equal(emptyScan.status, 0, emptyScan.stdout + emptyScan.stderr);
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'self.ts');
    fs.writeFileSync(file, code + code.replace('calculate', 'another'));
    git('add', '.'); git('commit', '-qm', 'same-file clones');
    const base = git('rev-parse', 'HEAD');
    assert.equal(scan(base).status, 0);
    assert.equal(scan(empty).status, 1);
    fs.writeFileSync(file, code + code.replace('calculate', 'another').replace(' total += values[15] * 52;', ' total = uniqueBoundary(total);'));
    git('add', '.'); git('commit', '-qm', 'recut same-file clone');
    const recut = scan(base);
    assert.equal(recut.status, 0, recut.stdout + recut.stderr);
    const grown = code.replace(' return total;', ' total += values[100] * 137;\n return total;');
    fs.writeFileSync(file, grown + grown.replace('calculate', 'another'));
    git('add', '.'); git('commit', '-qm', 'grow same-file clone');
    const growth = scan(base);
    assert.equal(growth.status, 1, growth.stdout + growth.stderr);
    assert.match(growth.stdout, /Clone token increase:.*baseline \d+, head \d+ tokens/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('named wait-baseline exception allows only its unordered file pair', () => {
  const server = 'packages/cezar/src/lint/wait-baseline.ts';
  const web = 'packages/web/src/test/wait-baseline.ts';
  const other = 'packages/contract/src/other.ts';
  const summary = (clones) => summarize(reportRoot, clones);
  const base = summary([]);
  for (const [first, second] of [[server, web], [web, server]]) {
    const clone = reportedClone(first, second, 100);
    clone.firstFile.start = 42;
    clone.secondFile.start = 99;
    assert.deepEqual(compare(base, summary([clone])), []);
    for (const tokens of [undefined, NaN, -1, 0, 1.5]) {
      assert.throws(() => summary([reportedClone(first, second, tokens)]), /Invalid clone accounting/);
    }
    clone.firstFile.start = 0;
    assert.throws(() => summary([clone]), /Invalid clone location/);
  }
  for (const first of [server, web]) {
    assert.match(compare(base, summary([reportedClone(first, other, 100)]))[0], /Cross-package clone/);
  }
  assert.match(compare(base, summary([reportedClone('packages/demo/src/a.ts', other, 100)]))[0], /Cross-package clone/);
});

// hearsay-tools/cezarion#2532: removing a copy can re-cut the remaining clone.
test('removes one copy of a repeated block without raising same-file tokens', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-remove-copy-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const folder = path.join(repo, 'packages/demo/src');
  const code = Array.from({ length: 12 }, (_, i) => ` total += values[${i}] * ${i + 37};`).join('\n');
  const block = (name, suffix = '') => `export function ${name}(values: number[]) {\n let total = 0;\n${code}\n${suffix}\n return total;\n}\n`;
  try {
    git('init', '--quiet'); fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'self.ts');
    const remaining = block('second', ' total = finishSecond(total);') + block('third', ' total = finishThird(total);');
    fs.writeFileSync(file, block('first') + remaining);
    git('add', '.'); git('commit', '-qm', 'three repeated blocks');
    const base = git('rev-parse', 'HEAD');
    fs.writeFileSync(file, remaining);
    git('add', '.'); git('commit', '-qm', 'remove first copy');
    const result = spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('same-file totals ignore fingerprints and cannot borrow another file or pair allowance', () => {
  const a = 'packages/demo/src/a.ts'; const b = 'packages/demo/src/b.ts';
  const summary = (clones) => summarize(reportRoot, clones);
  const base = summary([reportedClone(a, a, 200, false), reportedClone(b, b, 200, false), reportedClone(a, b, 200, false)]);
  for (const tokens of [199, 200]) {
    assert.deepEqual(compare(base, summary([reportedClone(a, a, 80), reportedClone(a, a, tokens - 80)])), []);
  }
  assert.deepEqual(compare(base, summary([])), []);
  const growth = compare(base, summary([reportedClone(a, a, 100, false), reportedClone(a, a, 101, false)]));
  assert.equal(growth.length, 1);
  assert.match(growth[0], /Clone token increase:.*baseline 200, head 201 tokens/);
  assert.match(compare(summary([reportedClone(a, b, 200)]), summary([reportedClone(a, a, 50, false)]))[0], /New same-file clone/);
});

test('a file moved with its same-file clone passes; a further copy of it still fails', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-move-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const folder = path.join(repo, 'packages/demo/src');
  const code = Array.from({ length: 12 }, (_, i) => ` total += values[${i}] * ${i + 37};`).join('\n');
  const block = (name) => `export function ${name}(values: number[]) {\n let total = 0;\n${code}\n return total;\n}\n`;
  const scan = (base) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
  try {
    git('init', '--quiet'); fs.mkdirSync(path.join(folder, 'moved'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'self.ts'), block('first') + block('second'));
    git('add', '.'); git('commit', '-qm', 'same-file clone');
    const base = git('rev-parse', 'HEAD');
    git('mv', 'packages/demo/src/self.ts', 'packages/demo/src/moved/self.ts');
    git('commit', '-qm', 'move');
    const moved = scan(base);
    assert.equal(moved.status, 0, moved.stdout + moved.stderr);
    fs.copyFileSync(path.join(folder, 'moved/self.ts'), path.join(folder, 'copy.ts'));
    git('add', '.'); git('commit', '-qm', 'copy');
    const copied = scan(base);
    assert.equal(copied.status, 1, copied.stdout + copied.stderr);
    assert.match(copied.stdout, /copy\.ts/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('a merge-base clone carries one head clone of the same fingerprint, in its own pair first, never across packages', () => {
  const { carryMoved } = require('./check-clones.cjs');
  const clone = (first, second, fragment = 'a\nb', tokens = 60) => ({ ...reportedClone(first, second, tokens), fragment });
  const a = 'packages/demo/src/a.ts'; const b = 'packages/demo/src/b.ts'; const c = 'packages/demo/src/c.ts'; const other = 'packages/web/src/x.ts';
  const kept = (base, head) => {
    const result = carryMoved(reportRoot, base, head);
    return { base: result.baseline.length, head: result.head.map(item => path.relative(reportRoot, item.secondFile.name)) };
  };
  assert.deepEqual(kept([clone(a, a)], [clone(c, c, '  a\n  b')]), { base: 0, head: [] }, 'layout is not part of the fingerprint');
  assert.deepEqual(kept([clone(a, b)], [clone(a, c), clone(a, b)]), { base: 0, head: [c] }, 'the clone that stayed is carried; the copy is reported');
  assert.deepEqual(kept([clone(a, b)], [clone(a, c, 'a\nb', 61)]), { base: 1, head: [c] }, 'another token count is another clone');
  assert.deepEqual(kept([clone(a, other)], [clone(b, other)]), { base: 1, head: [other] });
  assert.throws(() => carryMoved(reportRoot, [], [reportedClone(a, b, 60)]), /Invalid clone fragment/);
});

// A move to another folder rewrites relative imports; resolved, they still name the same modules.
test('a clone pair moved to other folders with rewritten relative imports passes; a new copy of it still fails', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-move-imports-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const write = (name, content) => { fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); fs.writeFileSync(path.join(repo, name), content); };
  const scan = (base) => spawnSync(process.execPath, [script, '--base', base], { cwd: repo, encoding: 'utf8' });
  const modules = ['discovery-options', 'product-env', 'probe-spawn', 'probe-teardown', 'model-catalog', 'effort-levels'];
  const source = (prefix, name) => modules.map((module, i) => `import { value${i}, type Type${i} } from '${prefix}${module}.ts';`).join('\n')
    + `\nimport { readFile } from 'node:fs/promises';\n\nexport const ${name} = [value0, value1, value2, value3, value4, value5, readFile];\n`;
  try {
    git('init', '--quiet');
    write('packages/demo/src/core/first.ts', source('./', 'first'));
    write('packages/demo/src/core/second.ts', source('./', 'second'));
    git('add', '.'); git('commit', '-qm', 'clone pair');
    const base = git('rev-parse', 'HEAD');
    git('rm', '-q', 'packages/demo/src/core/first.ts', 'packages/demo/src/core/second.ts');
    write('packages/demo/src/runners/first/first.ts', source('../../core/', 'first'));
    write('packages/demo/src/runners/second/second.ts', source('../../core/', 'second'));
    git('add', '.'); git('commit', '-qm', 'move with rewritten imports');
    const moved = scan(base);
    assert.equal(moved.status, 0, moved.stdout + moved.stderr);
    write('packages/demo/src/runners/third/third.ts', source('../../core/', 'third'));
    git('add', '.'); git('commit', '-qm', 'new copy');
    const copied = scan(base);
    assert.equal(copied.status, 1, copied.stdout + copied.stderr);
    assert.match(copied.stdout, /runners\/third\/third\.ts/);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('only module sources resolve, from the file the fragment was cut from', () => {
  const { carryMoved, withModuleSources } = require('./check-clones.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-sources-'));
  let files = 0;
  // The fragment starts on line 3, after an import that is not part of the clone.
  const clone = (folder, fragment, extension = 'ts') => {
    const name = `packages/demo/src/${folder}/f${files += 1}.${extension}`;
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), `import { before } from './before-${files}.ts';\n\n${fragment}\nexport const after = 1;\n`);
    const reported = { firstFile: { name: path.join(root, name), start: 3 }, secondFile: { name: path.join(root, 'packages/demo/src/z.ts'), start: 1 }, tokens: 60, isNew: true, fragment };
    return withModuleSources(root, [reported])[0];
  };
  const carried = (base, head) => carryMoved(root, [base], [head]).head.length === 0;
  const imports = (source) => `import { value } from '${source}';\nexport { other } from /* keep */ "${source}";\nexport * from '${source}';\nimport '${source}';\n`
    + `const late = await import(\`${source}\`);\nconst old = require("${source}");\nimport legacy = require('${source}');\ntype Late = import('${source}').Late;`;
  try {
    assert.equal(clone('a', imports('./x.ts')).moduleSources.length, 8, 'every module source form inside the fragment, none before it');
    assert.ok(carried(clone('a', imports('./x.ts')), clone('b/c', imports('../../a/x.ts'))), 'the same modules from another folder');
    assert.ok(!carried(clone('a', imports('./x.ts')), clone('b', imports('../other/x.ts'))), 'another x.ts');
    assert.ok(!carried(clone('a', imports('./x.ts')), clone('b', imports('./x.ts'))), 'the same text names another x.ts');
    assert.ok(carried(clone('a', imports('pkg/x.ts')), clone('b', imports('pkg/x.ts'))), 'a package source is kept as written');
    assert.ok(!carried(clone('a', imports('pkg/x.ts')), clone('b', imports('pkg/y.ts'))));
    const jsx = (source) => `import { View } from '${source}';\nexport const Page = () => <View label="./x.tsx" />;`;
    assert.ok(carried(clone('a', jsx('./view.tsx'), 'tsx'), clone('b/c', jsx('../../a/view.tsx'), 'tsx')), 'a .tsx file parses with JSX');
    // Text that only looks like an import is a string or a comment: it stays as written.
    const lookalike = (source) => `const text = \`import "${source}"\`;\n// import { x } from '${source}';\nconst plain = 'from "${source}"';\nconst call = notRequire('${source}');`;
    const moved = clone('moved', lookalike('./x.ts'));
    assert.deepEqual(moved.moduleSources, []);
    assert.ok(carried(clone('a', lookalike('./x.ts')), moved), 'an unchanged clone moved with its strings');
    assert.ok(!carried(clone('a', lookalike('./x.ts')), clone('a', lookalike('./nested/../x.ts'))), 'two different strings stay two clones');
    assert.ok(!carried(clone('a', imports('packages/demo/src/a/x.ts')), clone('a', imports('./x.ts'))), 'a resolved source never reads as written text');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
