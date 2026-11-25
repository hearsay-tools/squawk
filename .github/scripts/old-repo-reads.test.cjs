// The repository moved from hearsay-tools/cezarion to hearsay-tools/squawk
// (hearsay-tools/squawk#4239). GitHub redirects single reads of the old name, but
// `gh issue list`, search and URL lookups (`gh project item-add --url`) find nothing.
// This test fails when a tracked script, skill or workflow builds such a read with
// the old name. Old citations such as hearsay-tools/cezarion#N stay valid; tests and
// fixtures use the old name as fake data, so they are not read.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const ROOTS = ['.github/scripts', '.github/workflows', 'scripts', '.ai/skills'];
const SKIPPED = /(?:\.test\.|\.testkit\.|(?:^|\/)(?:fixtures|__fixtures__)\/)/;
const OLD_NAME_READ = [
  /(?:--repo[ =]|-R |repo:|repos\/|github\.com\/)hearsay-tools\/cezarion\b/,
  /owner:\s*['"]hearsay-tools['"]\s*,\s*repo:\s*['"]cezarion['"]/,
];

const oldNameReads = (files, read) => files.flatMap((file) =>
  read(file).split('\n').flatMap((text, index) =>
    OLD_NAME_READ.some((pattern) => pattern.test(text)) ? [`${file}:${index + 1}: ${text.trim()}`] : []));

test('finds old-name reads in commands, API paths, URLs and owner/repo objects, and passes citations', () => {
  const lines = {
    'a.sh': 'gh issue list --repo hearsay-tools/cezarion --label x\ngh pr view 1 -R hearsay-tools/cezarion',
    'b.cjs': "q: 'repo:hearsay-tools/cezarion is:issue'\napi('repos/hearsay-tools/cezarion/pulls')\nconst r = { owner: 'hearsay-tools', repo: 'cezarion' };",
    'c.md': 'Open https://github.com/hearsay-tools/cezarion/issues/12.\nCite hearsay-tools/cezarion#12 or use --repo hearsay-tools/squawk.',
  };
  assert.deepEqual(oldNameReads(Object.keys(lines), (file) => lines[file]).map((hit) => hit.split(': ')[0]), [
    'a.sh:1', 'a.sh:2', 'b.cjs:1', 'b.cjs:2', 'b.cjs:3', 'c.md:1',
  ]);
});

test('no tracked script, skill or workflow reads GitHub under the old repository name', () => {
  const files = execFileSync('git', ['ls-files', '-z', '--', ...ROOTS], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0').filter((file) => file && !SKIPPED.test(file));
  assert.ok(files.length > 0, `git ls-files found no file under ${ROOTS.join(', ')}`);
  const hits = oldNameReads(files, (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8'));
  assert.deepEqual(hits, [], [
    'These lines read GitHub under hearsay-tools/cezarion, which list, search and URL lookups no longer find.',
    'Use hearsay-tools/squawk, or the repository from the workflow context.',
  ].join('\n'));
});
