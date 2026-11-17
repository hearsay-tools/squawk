// Trusted CI code: count test lines from Git objects; never load code from the head.
// Rules: docs/sdlc/ci.md § Test line budget (hearsay-tools/squawk#3810).
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { resolvePullRequest } = require('./baseline-growth.cjs');

const SECTION_LIMIT = 400;
const LABEL_LIMIT = 1000;
const LABEL = 'test-budget';
const SECTION = 'Test budget';

const CODE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const TEST_NAME = /\.(?:test|spec|e2e)\./;
const SUPPORT_DIRS = new Set(['e2e', 'test', 'fixtures']);
const SKIPPED_DIRS = new Set(['dist', 'node_modules']);

/** True for test code: unit tests, browser specs and test-support code. */
function isTestFile(file) {
  if (!CODE.test(file) || DECLARATION.test(file)) return false;
  const parts = file.split('/');
  const name = parts.pop();
  if (parts.some(dir => SKIPPED_DIRS.has(dir))) return false;
  const stem = name.slice(0, name.lastIndexOf('.'));
  return TEST_NAME.test(name) || parts.some(dir => SUPPORT_DIRS.has(dir))
    || name.startsWith('mock-') || stem.endsWith('-harness') || stem === 'test-helpers';
}

// Rename detection off: a moved or split file is a deletion plus additions, so it nets to 0.
const DIFF = ['diff', '--no-ext-diff', '--no-textconv', '--no-renames'];

/**
 * Net test lines between two commits. `git(...args)` returns Git's stdout as text.
 * Binary rows (`-`) carry no lines and are skipped.
 */
function countTestLines(git, base, head) {
  const files = [];
  for (const row of git(...DIFF, '--numstat', '-z', base, head, '--').split('\0').filter(Boolean)) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(row);
    if (!match) throw new Error(`Unreadable numstat row: ${JSON.stringify(row)}`);
    const [, added, removed, file] = match;
    if (added === '-' || !isTestFile(file)) continue;
    files.push({ file, added: Number(added), removed: Number(removed) });
  }
  const created = new Set(git(...DIFF, '--name-only', '--diff-filter=A', '-z', base, head, '--').split('\0'));
  const added = files.reduce((sum, f) => sum + f.added, 0);
  const removed = files.reduce((sum, f) => sum + f.removed, 0);
  return { net: added - removed, added, removed, files, newFiles: files.filter(f => created.has(f.file)).map(f => f.file) };
}

/** The text under the PR body's `## Test budget` heading, without HTML comments. */
function budgetSection(body) {
  const lines = String(body ?? '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s+test budget\s*$/i.test(line.trim()));
  if (start < 0) return '';
  const end = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** What a PR with this net count needs, in one sentence. */
function requirement(net) {
  if (net <= SECTION_LIMIT) return `At or under +${SECTION_LIMIT}: no PR-body section or label needed.`;
  const section = `the PR body needs a \`## ${SECTION}\` section that names, for each new test file, the behavior it protects and why no existing test covers it`;
  if (net <= LABEL_LIMIT) return `Over +${SECTION_LIMIT}: ${section}. Deleting or merging tests elsewhere to reach +${SECTION_LIMIT} also passes.`;
  return `Over +${LABEL_LIMIT}: ${section}, and the owner's \`${LABEL}\` label. An agent never adds the label.`;
}

/** Failure reasons for a net count, a PR body and its label names. */
function judgeBudget({ net, body, labels }) {
  const reasons = [];
  if (net > SECTION_LIMIT && !budgetSection(body)) reasons.push(`The PR body has no non-empty \`## ${SECTION}\` section.`);
  if (net > LABEL_LIMIT && !labels.includes(LABEL)) reasons.push(`The PR has no \`${LABEL}\` label.`);
  return reasons;
}

function report(count) {
  const sign = n => (n > 0 ? `+${n}` : String(n));
  const rows = count.files.map(f => `| \`${f.file.replace(/[|`]/g, c => `\\${c}`)}\` | +${f.added} | -${f.removed} | ${count.newFiles.includes(f.file) ? 'yes' : ''} |`);
  return [
    `## Test line budget: ${sign(count.net)} net test lines`,
    '',
    `+${count.added} added, -${count.removed} removed in ${count.files.length} test file${count.files.length === 1 ? '' : 's'}. ${requirement(count.net)}`,
    '',
    ...(rows.length ? ['| File | Added | Removed | New |', '|---|---:|---:|---|', ...rows, ''] : []),
  ].join('\n');
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20, stdio: 'pipe' });
}

// Called only after the workflow checks out the trusted base. The PR body and labels are read
// live, so a re-run of the job sees an edited body or a new label.
async function checkPullRequest({ github, context, core, cwd = process.cwd() }) {
  const resolved = await resolvePullRequest({ github, context, cwd });
  if (!resolved) return;
  const { pr, head, mergeBase } = resolved;
  const count = countTestLines((...args) => git(cwd, ...args), mergeBase, head);
  const text = report(count);
  await core.summary.addRaw(text).write();
  core.info(text);
  const reasons = judgeBudget({ net: count.net, body: pr.body, labels: pr.labels.map(label => label.name) });
  if (reasons.length) core.setFailed(`${reasons.join('\n')}\nAdd what is missing, then re-run the failed classify-pr job. See docs/sdlc/ci.md § Test line budget.`);
}

// Local reproduction: node .github/scripts/test-budget.cjs --base origin/main [--head HEAD] [--body-file <file>] [--label <name>]...
// With --body-file, it judges the body and labels and exits 1 when the check would fail.
function main(args) {
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const base = opt('--base') ?? 'origin/main';
  const head = opt('--head') ?? 'HEAD';
  const read = (...a) => git(process.cwd(), ...a);
  const count = countTestLines(read, read('merge-base', base, head).trim(), head);
  console.log(report(count));
  const bodyFile = opt('--body-file');
  if (bodyFile === undefined) return 0;
  const labels = args.flatMap((arg, i) => (arg === '--label' ? [args[i + 1]] : []));
  const reasons = judgeBudget({ net: count.net, body: fs.readFileSync(bodyFile, 'utf8'), labels });
  console.log(reasons.length ? `FAIL\n${reasons.join('\n')}` : 'PASS');
  return reasons.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { SECTION_LIMIT, LABEL_LIMIT, LABEL, isTestFile, countTestLines, budgetSection, requirement, judgeBudget, report, checkPullRequest };
