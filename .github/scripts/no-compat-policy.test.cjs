'use strict';

// Squawk makes no compatibility promise (AGENTS.md, Changing what already works).
// The old BACKWARD_COMPATIBILITY.md policy file, and comments that cite it or call
// something a "protected surface", made agents add aliases, fallbacks and
// compatibility paragraphs. This test keeps the file deleted and its citations out
// of live docs and code. History stays as written: the changelog, run records,
// upstream ledgers, analyses and specs dated before the policy ended.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..', '..');
const SELF = path.relative(repoRoot, __filename).split(path.sep).join('/');
const POLICY_FILE = /(^|\/)backwards?_compatibility(\.[a-z]+)?$/i;
const CITATION = 'backwards?_compatibility|protected surface';
// Specs named on or after this date are live; older ones record finished designs.
const LIVE_SPEC_DATE = '2026-11-15';
const HISTORY = [
  'CHANGELOG.md',
  '.ai/runs/',
  '.ai/upstream/',
  '.ai/analysis/',
  '.ai/specs/assets/',
  '.ai/specs/briefs/',
  'docs/superpowers/',
];

function git(args) {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if (error.status === 1 && !error.stderr?.length) return '';
    throw error;
  }
}

function isHistory(file) {
  if (file === SELF) return true;
  if (HISTORY.some(prefix => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix))) return true;
  if (/^\.ai\/specs\/\d{3}-[^/]+$/.test(file)) return true;
  const dated = /^\.ai\/specs\/(\d{4}-\d{2}-\d{2})-[^/]+$/.exec(file);
  return dated !== null && dated[1] < LIVE_SPEC_DATE;
}

test('no compatibility policy file is tracked', () => {
  const files = git(['ls-files', '-z']).split('\0').filter(file => POLICY_FILE.test(file));
  assert.deepEqual(files, [], [
    'Squawk makes no compatibility promise (AGENTS.md, Changing what already works).',
    'Mark a breaking change with `!` in the PR title; keep no compatibility policy file.',
  ].join('\n'));
});

test('live docs and code do not cite a compatibility policy', () => {
  const hits = git(['grep', '-n', '-I', '-i', '-E', CITATION])
    .split('\n')
    .filter(Boolean)
    .filter(line => !isHistory(line.slice(0, line.indexOf(':'))));
  assert.deepEqual(hits, [], [
    'Squawk makes no compatibility promise (AGENTS.md, Changing what already works).',
    'State the behavior and its reason instead, e.g. "old bookmarks use this flat URL".',
  ].join('\n'));
});

test('history paths and dated specs are told apart', () => {
  assert.equal(isHistory('CHANGELOG.md'), true);
  assert.equal(isHistory('.ai/runs/2026-07-18-x.md'), true);
  assert.equal(isHistory('.ai/specs/013-install-as-command.md'), true);
  assert.equal(isHistory('.ai/specs/2026-11-06-rebrand-and-home-layout.md'), true);
  assert.equal(isHistory(`.ai/specs/${LIVE_SPEC_DATE}-new-design.md`), false);
  assert.equal(isHistory('.ai/specs/TEMPLATE.md'), false);
  assert.equal(isHistory('docs/areas/cli.md'), false);
  assert.equal(isHistory('packages/cezar/src/server/server.ts'), false);
  assert.equal(POLICY_FILE.test('BACKWARD_COMPATIBILITY.md'), true);
  assert.equal(POLICY_FILE.test('docs/backwards_compatibility.md'), true);
  assert.equal(POLICY_FILE.test('docs/compatibility.md'), false);
});
