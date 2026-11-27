const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EQUIVALENT_DIR, readEquivalent, matchesEntry, findEquivalent, sourceSite } = require('./mutants-equivalent.cjs');

const root = path.resolve(__dirname, '../..');
const entry = { file: 'packages/contract/src/attention.ts', function: 'attention', mutator: 'BooleanLiteral', original: 'true', replacement: 'false', reason: 'same behavior' };
const { file: ignored, ...row } = entry;

/** A scratch record directory: each key is a path below it, each value the file text. */
function fixture(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'equivalent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

const record = (t, rows) => fixture(t, { [`${entry.file}.json`]: JSON.stringify(rows) });

test('the default directory is relative to the checked-out repository', () => {
  assert.equal(EQUIVALENT_DIR, '.github/mutants/equivalent');
});

test('readEquivalent takes each file from its record path and reads nested records in path order', t => {
  const other = { function: 'other', mutator: 'StringLiteral', original: "'a'", replacement: "''", reason: 'same text', site: 'return ' };
  const dir = fixture(t, {
    'packages/web/src/z.tsx.json': JSON.stringify([other]),
    [`${entry.file}.json`]: JSON.stringify([row, { ...row, function: 'second' }]),
  });
  assert.deepEqual(readEquivalent(dir), { entries: [entry, { ...entry, function: 'second' }, { file: 'packages/web/src/z.tsx', ...other }], warning: '' });
});

test('readEquivalent accepts a missing and an empty directory', t => {
  assert.deepEqual(readEquivalent(path.join(fixture(t), 'missing')), { entries: [], warning: '' });
  assert.deepEqual(readEquivalent(fixture(t)), { entries: [], warning: '' });
});

test('readEquivalent warns without throwing on unreadable or malformed records', t => {
  const malformed = ['{', '{}', '[]', '[null]', ...Object.keys(row).map(key => JSON.stringify([{ ...row, [key]: ' ' }])), JSON.stringify([{ ...row, reason: 1 }])];
  for (const contents of malformed) {
    const result = readEquivalent(fixture(t, { [`${entry.file}.json`]: contents, 'packages/a.ts.json': JSON.stringify([row]) }));
    assert.deepEqual(result.entries, []);
    assert.match(result.warning, /^Could not read equivalent mutants: packages\/contract\/src\/attention\.ts\.json: /);
    assert.doesNotMatch(result.warning, /[\r\n]/);
  }
  const result = readEquivalent('denied', { readdirSync() { throw Object.assign(new Error('permission\ndenied'), { code: 'EACCES' }); } });
  assert.deepEqual(result.entries, []);
  assert.match(result.warning, /permission denied/);
});

test('readEquivalent rejects an empty record, an entry that names its file and a file that is not a .json record', t => {
  assert.match(readEquivalent(record(t, [])).warning, /at least one entry/);
  assert.match(readEquivalent(record(t, [entry])).warning, /must not hold file/);
  assert.match(readEquivalent(record(t, { 0: row })).warning, /expected an array/);
  const stray = readEquivalent(fixture(t, { [`${entry.file}.json`]: JSON.stringify([row]), 'packages/contract/src/README.md': 'notes' }));
  assert.deepEqual(stray.entries, []);
  assert.match(stray.warning, /packages\/contract\/src\/README\.md is not a \.json record file/);
});

test('the repository records load with no warning, one source file per record', () => {
  const { entries, warning } = readEquivalent(path.join(root, EQUIVALENT_DIR));
  assert.equal(warning, '');
  assert.ok(entries.length > 0);
  for (const { file } of entries) assert.ok(fs.existsSync(path.join(root, file)), `${file} names a source file`);
});

test('two branches that add records for different source files merge without a conflict', t => {
  const repo = fixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'init.defaultBranch=main', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  const add = (source, rows) => {
    const file = path.join(repo, EQUIVALENT_DIR, `${source}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
    git('add', '-A');
    git('commit', '-qm', `equivalent ${source}`);
  };
  git('init', '-q');
  add('packages/cezar/src/base.ts', [row]);
  git('checkout', '-qb', 'one');
  add('packages/cezar/src/one.ts', [row]);
  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'two');
  add('packages/cezar/src/two.ts', [row]);
  const tree = git('merge-tree', '--write-tree', 'one', 'two');
  assert.match(tree, /^[0-9a-f]{40,64}$/);
  git('read-tree', tree);
  git('checkout-index', '-a', '-f');
  assert.deepEqual(readEquivalent(path.join(repo, EQUIVALENT_DIR)).entries.map(e => e.file), ['packages/cezar/src/base.ts', 'packages/cezar/src/one.ts', 'packages/cezar/src/two.ts']);
});

test('matching requires function identity and exact full source text', () => {
  const long = 'x'.repeat(250);
  const row = { ...entry, original: long };
  assert.equal(matchesEntry(row, { ...row }), true);
  const { function: ignored, ...withoutFunction } = row;
  assert.equal(matchesEntry(row, withoutFunction), false);
  for (const changed of [{ file: 'other' }, { mutator: 'StringLiteral' }, { function: 'other' }, { original: long + 'x' }, { replacement: 'true' }]) {
    assert.equal(matchesEntry(row, { ...row, ...changed }), false);
  }
  assert.equal(findEquivalent([row], row), row);
  assert.equal(findEquivalent([], row), undefined);
});

test('string, template, regex whitespace and source formatting remain exact', () => {
  for (const [original, different] of [["'a b'", "'a  b'"], ['"a b"', '"a  b"'], ['`a b`', '`a  b`'], ['/a b/', '/a  b/'], ['return\nvalue', 'return value'], ['{\n  return true;\n}', '{\n    return true;\n}']]) {
    assert.equal(matchesEntry({ ...entry, original }, { ...entry, original: different }), false);
    assert.equal(matchesEntry({ ...entry, replacement: original }, { ...entry, replacement: different }), false);
  }
});


test('an optional site selects one exact source prefix', () => {
  const scoped = { ...entry, site: 'return ' };
  assert.equal(matchesEntry(scoped, { ...entry, site: 'return ' }), true);
  assert.equal(matchesEntry(scoped, { ...entry, site: 'const value = ' }), false);
  assert.equal(matchesEntry(scoped, entry), false);
  assert.equal(matchesEntry(entry, { ...entry, site: 'any line' }), true);
});

test('readEquivalent accepts a site and rejects invalid optional sites', t => {
  assert.deepEqual(readEquivalent(record(t, [{ ...row, site: 'return ' }])), { entries: [{ ...entry, site: 'return ' }], warning: '' });
  for (const site of ['', ' ', null, 1]) {
    assert.match(readEquivalent(record(t, [{ ...row, site }])).warning, /site/);
  }
});


test('source prefixes separate identical literals on one line and survive line moves', () => {
  const line = "  const [name = '', sha = ''] = parts;";
  assert.equal(sourceSite(line, { start: { line: 1, column: 17 } }), 'const [name = ');
  assert.equal(sourceSite('\n' + line, { start: { line: 2, column: 27 } }), "const [name = '', sha = ");
  assert.equal(sourceSite('true;', { start: { line: 1, column: 1 } }), '');
});


test('a missing source line cannot match a site but preserves site-less matching', () => {
  const site = sourceSite('', { start: { line: 2, column: 1 } });
  assert.equal(site, undefined);
  assert.equal(matchesEntry({ ...entry, site: 'return ' }, { ...entry, site }), false);
  assert.equal(matchesEntry(entry, { ...entry, site }), true);
});
