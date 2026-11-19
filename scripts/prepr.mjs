#!/usr/bin/env node
// One local gate before a PR opens (spec: .ai/specs/2026-11-11-one-full-run-delivery-pipeline.md,
// § Before the PR). It reads Squeal's results for the changed files and for lint, and runs
// what Squeal does not cover: repository lint checks, typecheck, citations, clones, spec statuses,
// the complexity ratchet and GitHub's per-file patch limits, and reports the test line budget.
// Edited test files and the test files that read a changed file directly need a current verdict;
// the rest of the selection with no result is reported as pending, and CI decides it.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { directImporters } from './direct-importers.mjs';
import { nodeTestReaders } from './test-inputs.mjs';

const require = createRequire(import.meta.url);
const { isDocsPath } = require('../.github/scripts/change-surface.cjs');
const { GITHUB_PATCH_LIMITS, localPatches, patchEnv } = require('../.github/scripts/missing-patches.cjs');
const { SECTION_LIMIT, countTestLines, requirement } = require('../.github/scripts/test-budget.cjs');

export const SQUEAL_WAIT_MS = 120_000;

/**
 * Judge one `squeal status --wait <ms> <paths> --json` result (exit code and parsed stdout). A
 * file with no result is missing when `isDirect` holds for it, and pending otherwise.
 */
export function judgeSqueal(exitCode, status, ignorePath = () => false, lintExpected = false, isDirect = () => true) {
  const selection = status?.selection ?? {};
  // Browser specs are CI's: Squeal runs them only on request.
  const files = (selection.testFiles ?? []).filter(f => !f.path.endsWith('.e2e.ts'));
  const unmatched = (selection.unmatched ?? []).map(u => u?.path ?? String(u)).filter(p => !ignorePath(p));
  const failed = files.filter(f => f.state === 'current' && !['pass', 'skip'].includes(f.verdict)).map(f => f.path);
  const failures = selection.verdict?.failures ?? {};
  const notCurrent = files.filter(f => f.state !== 'current');
  const missing = [...discoveryMissing(selection), ...notCurrent.filter(f => isDirect(f.path)).map(f => f.path)];
  const pending = notCurrent.filter(f => !isDirect(f.path)).map(f => ({ path: f.path, reason: f.reason }));
  const lint = lintOf(status, lintExpected);
  // A failure keeps the files with no result and the unmatched paths, so the report names them too.
  if (exitCode === 1 || failed.length || failures.tests || failures.testFiles || failures.setups || lint.failing) {
    return { state: 'fail', failed, missing, pending, unmatched, lint };
  }
  // Lint that has not finished is not judged here: prepr runs `npm run lint` for it.
  const state = missing.length || unmatched.length ? 'incomplete' : 'pass';
  return { state, failed: [], missing, pending, unmatched, lint, count: files.length - pending.length };
}

/** Test discovery with no result yet: before Squeal lists the revision's test files, current cached files are not the whole selection. */
function discoveryMissing(selection) {
  const unlisted = selection.verdict?.unlisted === true || (selection.result === 'none' && ['unlisted', 'unsynced'].includes(selection.reason));
  return unlisted ? [`test discovery: Squeal has not listed the test files of the current revision (${selection.reason ?? 'unlisted'})`] : [];
}

// lintExpected: a changed file is one Squeal lints, so a lint run that has not started is not a clean one.
function lintOf(status, lintExpected = false) {
  const l = status?.lint;
  if (!l) return { failing: 0, unfinished: 1 };
  if (l.off || l.failed || l.unreadable) return { failing: l.failing ?? 0, unfinished: 1, unavailable: String(l.off ?? l.failed ?? l.unreadable) };
  // Squeal omits `linting` once lint is done; an object with total 0 is a run that has not started.
  const total = l.linting?.total ?? 0;
  const notDone = l.linting ? Math.max(0, total - (l.linting.done ?? 0)) + (lintExpected && total === 0 ? 1 : 0) : 0;
  return { failing: l.failing ?? 0, unfinished: (l.pending ?? 0) + (l.stale ?? 0) + (l.unknown ?? 0) + notDone };
}

/** True when the parsed status shows a live Squeal daemon for this worktree. */
export function daemonAlive(status) {
  return status?.available === true && status?.daemon?.state === 'alive';
}

function run(cmd, args, options = {}) {
  return new Promise(resolve => {
    // Only npm, whose arguments are fixed here, goes through the Windows shell: never a file name.
    const npmOnWindows = process.platform === 'win32' && cmd === 'npm';
    const child = spawn(npmOnWindows ? 'npm.cmd' : cmd, args, { shell: npmOnWindows, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => resolve({ code: 127, out, err: err + String(e) }));
    child.on('close', code => resolve({ code: code ?? 1, out, err }));
  });
}

const tail = (text, n = 15) => text.trim().split('\n').slice(-n).join('\n');

const KILL_GRACE_MS = 10_000;
const LINTED = /^packages\/.*\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const NO_SQUEAL = { daemon: true, state: 'pass', count: 0, failed: [], missing: [], lint: { failing: 0, unfinished: 0 } };

/** Git readers for one checkout: `git` returns text, `gitBytes` a patch read's Buffer. */
export const gitIo = (cwd = undefined) => ({
  git: (...a) => spawnSync('git', a, { cwd, encoding: 'utf8' }).stdout,
  // A failed read throws: an empty patch from a failed command is not an empty change.
  gitBytes: (...a) => {
    const r = spawnSync('git', a, { cwd, env: patchEnv(), maxBuffer: 256 << 20 });
    if (r.status === 0) return r.stdout;
    const args = a.filter((x, i) => x !== '-c' && a[i - 1] !== '-c' && !x.startsWith('--')).join(' ');
    throw new Error(`git ${args} failed (exit ${r.status ?? r.signal ?? r.error?.code}): ${String(r.stderr ?? r.error).trim()}`);
  },
});

export const realIo = {
  run,
  ...gitIo(),
  nodeTests: paths => nodeTestReaders(paths, process.cwd()),
  directImporters: (testFiles, changed) => directImporters(process.cwd(), testFiles, changed),
  load: () => ({ load: os.loadavg()[0], cpus: os.availableParallelism() }),
  now: () => Date.now(),
};

/** One `squeal status --json` call, waiting up to `waitMs` when it is positive. `stop` is the result when it ends the check. */
async function squealStatus(paths, waitMs, io) {
  const wait = waitMs > 0 ? ['--wait', String(waitMs)] : [];
  const r = await io.run('squeal', ['status', ...wait, '--json', ...paths], { timeout: waitMs + KILL_GRACE_MS });
  let status;
  try { status = JSON.parse(r.out); } catch { status = undefined; }
  if (r.code === 127) return { stop: { daemon: false } };
  // Output that is not Squeal's JSON (a timeout kill, a crash) is an unknown result, not an absent daemon.
  if (status === undefined) {
    const lint = { failing: 0, unfinished: 0, unavailable: 'squeal status was unreadable' };
    return { stop: { daemon: true, state: 'unreadable', exit: r.code, output: tail(r.out + r.err, 5), lint } };
  }
  if (!daemonAlive(status)) return { stop: { daemon: false } };
  return { code: r.code, status };
}

/**
 * Squeal's verdict on the changed paths within `waitMs`. It first waits on the edited test files and
 * the test files that read a changed file directly, then on the whole selection with the time left.
 */
export async function squealChecks(paths, waitMs, io = realIo) {
  const lintExpected = paths.some(p => LINTED.test(p));
  const ignore = p => p.endsWith('.e2e.ts') || isDocsPath(p);
  const deadline = io.now() + waitMs;
  const first = await squealStatus(paths, 0, io);
  if (first.stop) return first.stop;
  const directOf = status => {
    const selected = (status.selection?.testFiles ?? []).filter(f => !ignore(f.path));
    return { selected, direct: new Set(io.directImporters(selected.map(f => f.path), paths)) };
  };
  const early = directOf(first.status);
  const directWaiting = early.selected.filter(f => early.direct.has(f.path) && f.state !== 'current').map(f => f.path);
  if (directWaiting.length) await squealStatus(directWaiting, Math.max(0, deadline - io.now()), io);
  const last = await squealStatus(paths, Math.max(0, deadline - io.now()), io);
  if (last.stop) return last.stop;
  // The first snapshot may come before discovery lists every test file: the final selection decides what is direct.
  const { direct } = directOf(last.status);
  return { daemon: true, load: io.load(), ...judgeSqueal(last.code, last.status, ignore, lintExpected, p => direct.has(p)) };
}

/** True when Squeal's lint result does not cover every changed file: prepr then runs `npm run lint`. */
export const lintUnfinished = lint => Boolean(lint.unfinished || lint.unavailable);

// Without a daemon: the focused tests only when the selection is not the full suite.
export async function focusedTests(base, io = realIo) {
  const baseArg = `--base=${base}`;
  const plan = await io.run('node', ['scripts/test-changed.mjs', baseArg, '--plan']);
  let mode;
  try { mode = JSON.parse(plan.out).mode; } catch { mode = 'unknown'; }
  if (mode === 'full') return { skipped: 'the selection is the full suite; CI runs it' };
  if (mode === 'skip') return { skipped: 'no tests selected' };
  return io.run('node', ['scripts/test-changed.mjs', baseArg]);
}

const detail = r => (r.code ? `\n${r.whole ? (r.out + r.err).trim() : tail(r.out + r.err)}` : '');
const entry = (ok, text) => ({ ok, text: `- ${ok ? 'pass' : 'FAIL'}: ${text}` });
// A local lint run lowers a shrink-only baseline and prints a `lowered:` line; the report keeps it so the commit is not missed.
export const loweredNotes = out => out.split('\n').filter(line => line.startsWith('lowered: ')).map(line => `\n  - ${line}`).join('');

/** Report lines for a Squeal result: an array of { ok, text }. */
export function squealLines(squeal, waitMs) {
  if (squeal.state === 'pass') {
    const lint = lintUnfinished(squeal.lint) ? '' : '; lint clean';
    return [entry(true, `Squeal: ${squeal.count} affected test file(s) current and passing${lint}`), ...pendingLines(squeal)];
  }
  if (squeal.state === 'unreadable') {
    return [entry(false, `Squeal: \`squeal status --wait\` exited ${squeal.exit} without a readable result, so the test and lint results are unknown. Run \`squeal status\`, then prepr again.${squeal.output ? `\n${squeal.output}` : ''}`)];
  }
  const lines = [];
  if (squeal.state === 'fail') {
    const what = squeal.failed.length ? `failing test files: ${squeal.failed.join(', ')}`
      : squeal.lint.failing ? `${squeal.lint.failing} lint finding(s)` : 'known test failures';
    lines.push(entry(false, `Squeal: ${what} (\`squeal failures\`, \`squeal status\`)`));
  }
  if (squeal.missing?.length) {
    lines.push(entry(false, `Squeal had no result within ${Math.round(waitMs / 1000)} s for these edited test files or direct readers of a changed file: ${names(squeal.missing)}. `
      + 'Get the results with `squeal status --wait 60000 <paths>` (parity and worker tests: `squeal run run-loop <paths> --wait 60000`), then run prepr again.'));
  }
  if (squeal.unmatched?.length) {
    lines.push(entry(false, `these changed paths select no test file: ${names(squeal.unmatched)}. `
      + 'Waiting does not change that: add a test that reads each path, or declare its reader in `squeal.config.json` `inputs`.'));
  }
  return [...lines, ...pendingLines(squeal)];
}

const pendingLines = squeal => (squeal.pending?.length ? [{ ok: true, text: pendingLine(squeal.pending, squeal.load) }] : []);

const CPU_WAIT = /^queued, waiting for CPU/;

/** The non-failing line for transitively affected test files with no result, counted by Squeal's cause. */
export function pendingLine(pending, { load, cpus } = {}) {
  const causes = new Map();
  for (const { reason } of pending) {
    const cause = CPU_WAIT.test(reason ?? '')
      ? `queued waiting for CPU at load ${Number.isFinite(load) ? load.toFixed(1) : 'unknown'} on ${cpus ?? 'unknown'} CPUs`
      : (reason ?? 'no cause given').split(':')[0];
    causes.set(cause, (causes.get(cause) ?? 0) + 1);
  }
  const counted = [...causes].map(([cause, n]) => `${n} ${cause}`).join('; ');
  return `- pending: ${pending.length} transitively affected test file(s) have no result (${counted}); CI decides. \`squeal status --full\` gives each cause.`;
}

const names = list => [...list.slice(0, 10), ...(list.length > 10 ? [`and ${list.length - 10} more`] : [])].join(', ');

/** The report line for `npm run lint`, run because Squeal's lint did not finish. */
export function lintFallbackLine(lint, r) {
  const why = lint.unavailable ? `is unavailable (${lint.unavailable})` : `did not finish for ${lint.unfinished} file(s)`;
  return entry(r.code === 0, `lint: Squeal's lint ${why}, so prepr ran \`npm run lint\`${detail(r)}${loweredNotes(r.out)}`);
}

/** The root node:test files the changed paths select (squeal.config.json `inputs`), run with node --test. */
async function nodeReaderLine(files, io) {
  const { argv, files: tests } = io.nodeTests(files);
  if (!tests.length) return { ok: true, text: '- skipped: node:test readers: the changed paths select none' };
  const r = await io.run('node', [...argv, '--test', ...tests]);
  return entry(r.code === 0, `node:test readers of the changed paths (${tests.length} file(s))${detail(r)}`);
}

/** Report lines when no Squeal daemon runs: the focused tests, the node:test readers and lint. */
export async function fallbackLines(base, files, io = realIo) {
  const [tests, nodeReaders, lint] = await Promise.all([focusedTests(base, io), nodeReaderLine(files, io), io.run('npm', ['run', '--silent', 'lint'])]);
  return [
    { ok: true, text: '- No Squeal daemon for this worktree: ran the focused checks (`npm run test:changed`, node:test readers, `npm run lint`).' },
    tests.skipped ? { ok: true, text: `- skipped: focused tests: ${tests.skipped}` }
      : entry(tests.code === 0, `focused tests (\`npm run test:changed\`)${detail(tests)}`),
    nodeReaders,
    entry(lint.code === 0, `lint (\`npm run lint\`)${detail(lint)}${loweredNotes(lint.out)}`),
  ];
}

/** True when the branch's open PR carries the owner's baseline-growth label. Any failed read is false. */
async function growthApproved(io) {
  const r = await io.run('gh', ['pr', 'view', '--json', 'state,labels']);
  // `gh pr view` falls back to a closed PR of the branch: only an open PR's label counts.
  try {
    const pr = JSON.parse(r.out);
    return r.code === 0 && pr.state === 'OPEN' && pr.labels.some(l => l.name === 'baseline-growth');
  } catch { return false; }
}

/** CI's complexity ratchet on the committed head, with --allow-growth when the owner approved growth. */
export async function complexityRun(base, io = realIo) {
  const approved = await growthApproved(io);
  const r = await io.run('node', ['.ai/skills/check-code-quality/scripts/complexity-gate.mjs', '--base', base, '--head', 'HEAD', ...(approved ? ['--allow-growth'] : [])]);
  // The whole report: each function's headline comes before its decision-point lines.
  return { ...r, whole: true, name: approved ? 'complexity (growth approved by the baseline-growth label)' : 'complexity' };
}

function mergeBaseOf(base, io) {
  const mergeBase = io.git('merge-base', base, 'HEAD').trim();
  if (!mergeBase) throw new Error(`No merge base with ${base}: run \`git fetch origin main\` first.`);
  return mergeBase;
}

/**
 * Report lines for GitHub's per-file patch limits on the committed branch: a file diff over
 * GITHUB_PATCH_LIMITS.fileBytes or one with a NUL byte gets no API patch, and the PR gate fails.
 * Renames are on, as on GitHub, so a moved file is measured by its rename patch.
 */
export function patchLimitLines(base, io = realIo) {
  const rows = localPatches(args => io.gitBytes(...args), mergeBaseOf(base, io), 'HEAD');
  const limit = GITHUB_PATCH_LIMITS.fileBytes;
  let added = 0;
  let deleted = 0;
  const refused = [];
  for (const { added: a, deleted: d, paths, facts, status } of rows) {
    if (a === '-') continue;
    added += Number(a);
    deleted += Number(d);
    if (status === 'D' && a === '0' && !facts.nul) continue;
    const cause = facts.nul ? 'its diff contains a NUL byte'
      : facts.bytes > limit ? `its diff is ${facts.bytes} bytes, over GitHub's ${limit}-byte per-file patch limit` : '';
    if (cause) refused.push(entry(false, `patch limits: ${JSON.stringify(paths.at(-1))}: ${cause}, so GitHub returns no patch and the PR gate fails. Split the change.`));
  }
  const total = `${added + deleted} changed lines (+${added}/-${deleted}) in ${rows.length} file${rows.length === 1 ? '' : 's'}`;
  if (refused.length) return [...refused, entry(false, `patch limits: ${refused.length} of ${rows.length} file diffs refused; ${total}`)];
  return [entry(true, `patch limits: every non-deletion file diff is at most ${limit} bytes with no NUL byte; ${total}`)];
}

/**
 * The test line budget on the committed branch, counted as CI counts it. It reports and never fails:
 * the PR body and labels that decide CI's result do not exist yet (docs/sdlc/ci.md § Test line budget).
 */
export function testBudgetLines(base, io = realIo) {
  const { net, added, removed, files, newFiles } = countTestLines((...a) => io.gitBytes(...a).toString('utf8'), mergeBaseOf(base, io), 'HEAD');
  const status = net > SECTION_LIMIT ? 'note' : 'pass';
  const created = newFiles.length ? ` New test files: ${newFiles.join(', ')}.` : '';
  return [{ ok: true, text: `- ${status}: test budget: ${net > 0 ? '+' : ''}${net} net test lines (+${added}/-${removed}) in ${files.length} file(s). ${requirement(net)}${created}` }];
}

function changedFiles(base, io) {
  const mergeBase = mergeBaseOf(base, io);
  const tracked = io.git('diff', '--name-only', '--no-renames', '-z', mergeBase);
  const untracked = io.git('ls-files', '--others', '--exclude-standard', '-z');
  return [...new Set(`${tracked}\0${untracked}`.split('\0').filter(Boolean))];
}

export async function prepr({ base = 'origin/main', waitMs = SQUEAL_WAIT_MS, io = realIo } = {}) {
  const files = changedFiles(base, io);
  const docsOnly = files.every(isDocsPath);
  const direct = [
    ['repository lint', 'node', ['packages/cezar/src/lint/run.ts', '--repository-only']],
    ...(docsOnly ? [] : [['typecheck', 'npm', ['run', '--silent', 'typecheck']]]),
    ['citations', 'node', ['.github/scripts/check-citations.cjs', '--base', base]],
    ['clones', 'node', ['.github/scripts/check-clones.cjs', '--base', base, '--head', 'HEAD']],
    ['spec statuses', 'node', ['.github/scripts/check-spec-status.cjs']],
  ];
  const directRuns = [...direct.map(([name, cmd, args]) => io.run(cmd, args).then(r => ({ ...r, name }))), complexityRun(base, io)];
  const squeal = files.length ? await squealChecks(files, waitMs, io) : NO_SQUEAL;
  const entries = squeal.daemon ? squealLines(squeal, waitMs) : await fallbackLines(base, files, io);
  if (squeal.daemon && lintUnfinished(squeal.lint)) entries.push(lintFallbackLine(squeal.lint, await io.run('npm', ['run', '--silent', 'lint'])));
  entries.push(...patchLimitLines(base, io), ...testBudgetLines(base, io));
  for (const r of await Promise.all(directRuns)) entries.push(entry(r.code === 0, `${r.name}${detail(r)}${loweredNotes(r.out)}`));
  if (docsOnly) entries.push({ ok: true, text: '- skipped: typecheck (docs-only change)' });
  const failed = entries.some(e => !e.ok);
  const head = io.git('rev-parse', '--short', 'HEAD').trim();
  const dirty = io.git('status', '--porcelain').trim() !== '';
  const report = [`prepr: ${failed ? 'FAIL' : 'PASS'}`, '', '### Local gate (`npm run prepr`)', '', `Head ${head}${dirty ? ' (uncommitted changes present)' : ''}, base ${base}, ${files.length} changed file(s).`, '', ...entries.map(e => e.text)].join('\n');
  return { failed, report };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--help')) {
    console.log('Usage: npm run prepr -- [--base <ref>] [--wait-ms <ms>]\nOne verdict and the PR-body evidence block. Squeal wait bound: 120000 ms.');
  } else {
    try {
      const { failed, report } = await prepr({ base: opt('--base'), waitMs: Number(opt('--wait-ms')) || undefined });
      console.log(report);
      process.exitCode = failed ? 1 : 0;
    } catch (error) {
      console.error(`prepr: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
