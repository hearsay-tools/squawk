#!/usr/bin/env node
// Iteration feedback only: never substitutes for the final validation gate.
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { unitFiles } from './ci-test-selection.mjs';
import { classify, existingTests } from './test-inputs.mjs';

// CI's docs-only rule: skip exactly the paths that skip CI's Vitest shards.
const { isDocsPath } = createRequire(import.meta.url)('../.github/scripts/change-surface.cjs');

const options = { plan: false, base: undefined, ci: false, forward: [] };
const argv = process.argv.slice(2);
for (const [index, arg] of argv.entries()) {
  if (arg === '--' && options.ci) { options.forward = argv.slice(index + 1); break; }
  if (arg === '--help' || arg === '-h') {
    const output = Promise.withResolvers();
    process.stdout.write(`Usage: npm run test:changed -- [--base=<ref>] [--plan] [--ci [-- <Vitest args>]] [--help | -h]

Selection rules:
  Compare against the merge-base with local origin/main (or main), including
  branch commits and staged, unstaged, and untracked files. No fetch is made.
  --base=<ref> overrides the comparison ref; its merge-base with HEAD is used.
  --plan prints the selection as JSON without running tests; with --ci it
  also resolves the test files.
  --ci resolves test files first and prints the specific reason when it runs
  full Vitest. With --ci, arguments after -- go to Vitest (including shard and
  coverage flags).
  Inspect --plan before running tests. If it selects the full suite, choose
  focused checks and leave full verification to CI.

  Each changed path, deleted and renamed paths included, takes the first rule
  that holds (scripts/test-inputs.mjs):
  1. Ordinary TS/JS source in packages/{cezar,web,api-client}/src selects tests
     through Vitest's import graph. Eligible extensions: ts, tsx, js, jsx, mjs.
  2. Manifests, the lockfile, tsconfig, Vitest configuration and the files the
     Vitest configuration imports fall back to full Vitest.
  3. A snapshot selects its test; a *.baseline.json selects the tests that
     declare its exact path.
  4. Any other path under packages/, including packages/contract, falls back
     to full Vitest.
  5. A path that squeal.config.json inputs declares selects its reader tests.
  6. A path no Vitest test reads (.github/mutants, .github/workflows,
     .github/scripts, scripts/*.test.mjs) selects nothing.
  7. Anything else falls back to full Vitest.
  Every path also selects the Vitest tests whose declared inputs match it, so
  a source change runs the scanner tests. Unusual paths and missing Git or base
  information fall back to full Vitest.

  Clean changes and changes confined to CI's docs-only list skip iteration tests.
  isDocsPath in .github/scripts/change-surface.cjs is the exact definition.
  Markdown listed in testReadDocuments is never docs-only.
  No matching test is an error; run npm test or select relevant tests explicitly
  and report any coverage gap.

To classify branch commits as CI does, run:
  git diff --name-only --no-renames origin/main...HEAD | jq -R . | node .github/scripts/change-surface.cjs
This prints docs-only, infra-only or full-matrix.

This command provides iteration feedback. Import graphs do not cover every
runtime dependency. CI's gate is final.
`, output.resolve);
    await output.promise;
    process.exit(0);
  }
  else if (arg === '--plan') options.plan = true;
  else if (arg === '--ci') options.ci = true;
  else if (arg.startsWith('--base=') && arg.length > 7) options.base = arg.slice(7);
  else {
    console.error(`Unknown argument: ${arg}. Use --base=<ref>, --plan, or --help.`);
    process.exit(2);
  }
}

const full = (reason, files = []) => ({ mode: 'full', reason, files, args: ['test'] });

// Per-path rules from scripts/test-inputs.mjs: deleted and renamed paths are
// classified like any other path.
function rules(inputs, cwd) {
  let rule;
  try { rule = classify(inputs, cwd); }
  catch (error) { return full(`Cannot read the declared test inputs: ${error.message}`); }
  if (rule.full) return full(rule.full);
  const tests = existingTests(cwd, rule.tests);
  if (!rule.sources.length && !tests.length) return { mode: 'skip', reason: 'No Vitest test reads the changed inputs', args: [] };
  return { mode: 'changed', reason: 'Vitest import graph plus declared readers', sources: rule.sources, tests };
}

function select() {
  let cwd = process.cwd();
  const git = (...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024,
  });
  try {
    cwd = git('rev-parse', '--show-toplevel').trim();
    let ref = options.base;
    if (!ref) {
      // No fetch and no network. An absent local base is not permission to skip.
      try { git('rev-parse', '--verify', 'origin/main^{commit}'); ref = 'origin/main'; }
      catch { ref = 'main'; }
    }
    const resolved = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim();
    const base = git('merge-base', 'HEAD', resolved).trim();
    const files = [...new Set([
      ...git('diff', '--no-renames', '--name-only', '-z', base, 'HEAD', '--').split('\0'),
      ...git('diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD', '--').split('\0'),
      ...git('diff', '--no-renames', '--name-only', '-z', '--').split('\0'),
      ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
    ].filter(Boolean))].sort();
    const inputs = files.filter(file => !isDocsPath(file));
    if (!inputs.length) return { mode: 'skip', reason: files.length ? 'Documentation-only changes' : 'No changes', base, files, args: [], cwd };
    return { ...rules(inputs, cwd), base, files, cwd };
  } catch {
    return { ...full('Cannot establish complete Git changes or merge-base'), cwd };
  }
}

let selection = select();
const forward = options.ci ? options.forward : [];
if (selection.mode === 'changed' && (options.ci || !options.plan)) {
  const resolved = unitFiles(selection);
  selection = resolved.files
    // CI shards may be empty after a nonempty global selection; a local run with no match is an error.
    ? { ...selection, args: ['test', '--', ...resolved.files, ...forward, `--passWithNoTests=${options.ci}`] }
    : { ...selection, mode: 'full', reason: resolved.reason, args: ['test', '--', ...forward] };
} else if (selection.mode === 'full' && options.ci) selection = { ...selection, args: ['test', '--', ...forward] };
if (options.plan) console.log(JSON.stringify(selection, null, 2));
else {
  console.log(`[test:changed] ${selection.mode}: ${selection.reason}`);
  console.log(options.ci ? '[test:changed] PR selection; the merge queue runs the full suite.' : '[test:changed] Iteration feedback only; the final validation gate is unchanged.');
  if (selection.mode !== 'skip') {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', selection.args, {
      cwd: selection.cwd, stdio: 'inherit', shell: process.platform === 'win32',
    });
    if (result.error) console.error(result.error.message);
    process.exitCode = result.status ?? 1;
  }
}
