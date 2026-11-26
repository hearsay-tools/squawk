#!/usr/bin/env node
// Red proof for a named break: build the break as a commit object over HEAD, then let
// `squeal proof` run the listed tests over it in its own temporary checkout. The work tree,
// its index, its branches and the stash stay untouched, so no test runner runs in a
// Squeal-watched worktree (AGENTS.md § Validation, docs/sdlc/regression-proof.md).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A condition makes Squeal run each side fresh: a stored result never belongs to a break commit,
// and the store path answers not comparable for it (hearsay-tools/squeal#266).
export const FRESH_RUN = 'SQUAWK_REGRESSION_PROOF=1';

export const RECIPES_DIR = fileURLToPath(new URL('./regression-proofs/', import.meta.url));

const USAGE = `Usage:
  node scripts/regression-proof.mjs <recipe> [--timeout <seconds>]
  node scripts/regression-proof.mjs --revert <commit> --test <file>... [--timeout <seconds>]
  node scripts/regression-proof.mjs --patch <file> --test <file>... [--timeout <seconds>]
  node scripts/regression-proof.mjs --list | --check | --help

A recipe is scripts/regression-proofs/<recipe>.json: { description, fixedBy, break, tests }.
Each break entry replaces one exact text, found exactly once, in one file; entries for
the same file apply in order, each to the text the earlier ones left.
--revert reverts one non-merge commit on top of HEAD. --patch applies a patch file that
introduces the break. The break commit is HEAD plus the break; it is never checked out.
\`squeal proof <tests> --base <break> --case source\` then runs red (the tests over the break)
and green (HEAD) outside this worktree. Every file the break changes, other than a named
test, goes to Squeal as --source, so a file the tests read at runtime or spawn counts as
product code. --env ${FRESH_RUN} makes Squeal run both sides fresh, never from its store.
Uncommitted changes are not part of the proof.
--check validates every recipe at HEAD without running tests.
Exit codes: 0 every file proven, 1 a file not red or not green, 3 a result unknown,
2 a usage error, a break that does not apply, or no squeal command.`;

export class ProofError extends Error {}

function gitRaw(cwd, args, options = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...options });
}

function git(cwd, args, options = {}) { return gitRaw(cwd, args, options).trim(); }

/** Every occurrence index of `find` in `text`. */
function occurrences(text, find) {
  const found = [];
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1)) found.push(at);
  return found;
}

/** Apply one recipe edit to a file's text, or say why it does not apply. */
export function applyEdit(text, edit) {
  const found = occurrences(text, edit.find).length;
  if (found !== 1) throw new ProofError(`${edit.file}: the break text occurs ${found} times, not once: ${JSON.stringify(edit.find)}`);
  return text.replace(edit.find, () => edit.replace);
}

function readRecipeFile(path) {
  let recipe;
  try { recipe = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new ProofError(`${path}: ${error.message}`); }
  return validateRecipe(recipe, basename(path, '.json'));
}

export function validateRecipe(recipe, name) {
  const fail = (what) => { throw new ProofError(`recipe ${name}: ${what}`); };
  if (typeof recipe?.description !== 'string' || !recipe.description) fail('needs a description');
  if (typeof recipe.fixedBy !== 'string' || !/^[0-9a-f]{7,40}$/.test(recipe.fixedBy)) fail('needs fixedBy, the commit that fixed the bug');
  if (!Array.isArray(recipe.break) || recipe.break.length === 0) fail('needs at least one break entry');
  for (const edit of recipe.break) {
    if (typeof edit?.file !== 'string' || typeof edit.find !== 'string' || !edit.find || typeof edit.replace !== 'string') fail('each break entry needs file, find and replace');
    if (edit.find === edit.replace) fail(`${edit.file}: find and replace are equal`);
  }
  if (!Array.isArray(recipe.tests) || recipe.tests.length === 0 || recipe.tests.some(test => typeof test !== 'string' || !test)) fail('needs a list of test files');
  return { name, ...recipe };
}

export function listRecipes(dir = RECIPES_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(file => file.endsWith('.json')).sort().map(file => readRecipeFile(join(dir, file)));
}

export function loadRecipe(name, dir = RECIPES_DIR) {
  const path = join(dir, `${name}.json`);
  if (!/^[\w.-]+$/.test(name) || !existsSync(path)) throw new ProofError(`no recipe ${name} in ${dir}`);
  return readRecipeFile(path);
}

/** Problems that stop a recipe at HEAD, read through `read(file)` (null when absent). */
export function recipeProblems(recipe, read) {
  const problems = [];
  for (const test of recipe.tests) if (read(test) === null) problems.push(`${recipe.name}: test file ${test} does not exist`);
  for (const [file, edits] of editsByFile(recipe.break)) {
    const text = read(file);
    if (text === null) { problems.push(`${recipe.name}: ${file} does not exist`); continue; }
    try { applyEdits(text, edits); } catch (error) { problems.push(`${recipe.name}: ${error.message}`); }
  }
  return problems;
}

/** The recipe's edits grouped by file, in recipe order. */
function editsByFile(edits) {
  const byFile = new Map();
  for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  return byFile;
}

/** Apply a file's edits in order, each to the text the earlier ones left. */
export function applyEdits(text, edits) {
  return edits.reduce((current, edit) => applyEdit(current, edit), text);
}

function headReader(cwd, head = 'HEAD') {
  return (file) => {
    try { return gitRaw(cwd, ['show', `${head}:${file}`]); } catch { return null; }
  };
}

/** Run `fn` with a temporary index that starts as `head`'s tree; returns fn's result. */
function withHeadIndex(cwd, head, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'regression-proof-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  try {
    git(cwd, ['read-tree', head], { env });
    return fn(env, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function recipeTree(cwd, head, recipe) {
  const read = headReader(cwd, head);
  return withHeadIndex(cwd, head, (env) => {
    for (const [file, edits] of editsByFile(recipe.break)) {
      const text = read(file);
      if (text === null) throw new ProofError(`${file}: not in HEAD`);
      const mode = git(cwd, ['ls-tree', head, '--', file]).split(/\s/)[0];
      const blob = git(cwd, ['hash-object', '-w', '--stdin'], { input: applyEdits(text, edits) });
      git(cwd, ['update-index', '--cacheinfo', `${mode},${blob},${file}`], { env });
    }
    return git(cwd, ['write-tree'], { env });
  });
}

function patchTree(cwd, head, patch) {
  return withHeadIndex(cwd, head, (env) => {
    try { git(cwd, ['apply', '--cached', resolve(patch)], { env }); }
    catch (error) { throw new ProofError(`${patch} does not apply to HEAD: ${error.stderr?.trim() || error.message}`); }
    return git(cwd, ['write-tree'], { env });
  });
}

function revertTree(cwd, head, commit) {
  const parents = git(cwd, ['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1);
  if (parents.length !== 1) throw new ProofError(`${commit} has ${parents.length} parents; --revert takes one non-merge commit`);
  const result = spawnSync('git', ['merge-tree', '--write-tree', '--name-only', `--merge-base=${commit}`, head, parents[0]], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new ProofError(`reverting ${commit} on HEAD conflicts:\n${result.stdout.trim()}`);
  return result.stdout.split('\n')[0].trim();
}

/** Build the break commit over one pinned `head` commit from one source; returns its id.
 * Every read uses `head`, so a commit that lands meanwhile (an autosave) cannot mix in. */
export function buildBreak(cwd, source, head = git(cwd, ['rev-parse', 'HEAD^{commit}'])) {
  let tree;
  if (source.recipe) tree = recipeTree(cwd, head, source.recipe);
  else if (source.patch) tree = patchTree(cwd, head, source.patch);
  else tree = revertTree(cwd, head, source.revert);
  if (tree === git(cwd, ['rev-parse', `${head}^{tree}`])) throw new ProofError('the break changes nothing at HEAD');
  return git(cwd, ['commit-tree', tree, '-p', head, '-m', `regression-proof break: ${source.label}`]);
}

// Squeal's NOT_SHOWN_TO_MATTER text. Squeal appends it to a proven file's reason when a
// condition made no difference, which is always true for FRESH_RUN.
const CONTROL_REASON = 'red without the conditions too: the conditions are not shown to matter';

function withoutControlReason(reason) {
  return reason?.split('; ').filter(part => part !== CONTROL_REASON).join('; ');
}

function plural(count, word) { return `${count} ${word}${count === 1 ? '' : 's'}`; }

/** Human summary of a squeal-proof/1 JSON report. */
export function summarize(report, label) {
  const lines = [`regression-proof ${label}: break ${report.base.slice(0, 12)} over HEAD ${report.head.slice(0, 12)}`];
  for (const file of report.files) {
    const failures = file.red?.failures ?? [];
    lines.push(`  ${file.verdict}: ${file.path}`);
    lines.push(`    red: ${file.red?.end ?? 'not read'}${failures.length ? `, ${plural(failures.length, 'failing test')}` : ''}; green: ${file.green?.end ?? 'not read'}`);
    for (const failure of failures.slice(0, 5)) {
      lines.push(`      ${failure.kind}: ${failure.test}`);
      // Squeal judges only assertions; show what else failed so a reader can tell a browser
      // spec's wait on the broken behavior from a setup error.
      const first = failure.kind === 'assertion' ? '' : String(failure.text ?? '').trim().split('\n')[0];
      if (first) lines.push(`        ${first}`);
    }
    if (failures.length > 5) lines.push(`      … and ${failures.length - 5} more`);
    const reason = withoutControlReason(file.reason);
    if (reason) lines.push(`    reason: ${reason}`);
  }
  const proven = report.files.filter(file => file.verdict === 'proven').length;
  lines.push(`proven ${proven}/${report.files.length}`);
  return lines.join('\n');
}

export function parseArgs(argv) {
  const options = { tests: [], timeout: undefined, mode: undefined, value: undefined };
  const take = (index) => {
    if (index >= argv.length || argv[index].startsWith('--')) throw new ProofError(`${argv[index - 1]} needs a value`);
    return argv[index];
  };
  const setMode = (mode, value) => {
    if (options.mode) throw new ProofError(`choose one of <recipe>, --revert, --patch, --list, --check (got ${options.mode} and ${mode})`);
    Object.assign(options, { mode, value });
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') setMode('help');
    else if (arg === '--list' || arg === '--check') setMode(arg.slice(2));
    else if (arg === '--revert' || arg === '--patch') setMode(arg.slice(2), take(++index));
    else if (arg === '--test') options.tests.push(take(++index));
    else if (arg === '--timeout') options.timeout = take(++index);
    else if (arg.startsWith('-')) throw new ProofError(`unknown option ${arg}`);
    else setMode('recipe', arg);
  }
  if (!options.mode) throw new ProofError('name a recipe, or use --revert, --patch, --list or --check');
  if ((options.mode === 'revert' || options.mode === 'patch') && options.tests.length === 0) throw new ProofError(`--${options.mode} needs at least one --test <file>`);
  if (options.mode === 'recipe' && options.tests.length) throw new ProofError('a recipe names its own tests; drop --test');
  if (options.timeout !== undefined && !/^[1-9]\d*$/.test(options.timeout)) throw new ProofError('--timeout takes whole seconds');
  return options;
}

/** Files the break changes that are not named tests: Squeal compares an unchanged test only
 * when every changed file is named, and --source names it as product code on both sides. */
export function breakSources(cwd, head, breakCommit, tests) {
  const named = new Set(tests);
  return gitRaw(cwd, ['diff', '--name-only', '-z', '--no-renames', head, breakCommit]).split('\0').filter(file => file && !named.has(file));
}

function runSquealProof(cwd, breakCommit, tests, sources, timeout) {
  const args = ['proof', ...tests, '--base', breakCommit, '--case', 'source',
    ...sources.flatMap(file => ['--source', file]), '--env', FRESH_RUN, '--json'];
  if (timeout) args.push('--timeout', timeout);
  const result = spawnSync('squeal', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error?.code === 'ENOENT') throw new ProofError('no squeal command on PATH: red proofs run through `squeal proof`; install Squeal, then run this again');
  if (result.error) throw result.error;
  let report;
  try { report = JSON.parse(result.stdout); } catch { report = undefined; }
  if (report?.version !== 'squeal-proof/1') throw new ProofError(`squeal proof exited ${result.status} without a squeal-proof/1 report:\n${result.stdout.trim()}`);
  return { report, status: result.status ?? 3 };
}

function sourceFor(cwd, options) {
  if (options.mode === 'recipe') {
    const recipe = loadRecipe(options.value);
    return { source: { recipe, label: recipe.name }, tests: recipe.tests };
  }
  const label = options.mode === 'revert' ? `revert ${git(cwd, ['rev-parse', '--short=12', `${options.value}^{commit}`])}` : `patch ${options.value}`;
  return { source: { [options.mode]: options.value, label }, tests: options.tests };
}

function checkAll(cwd, out) {
  const read = headReader(cwd);
  const recipes = listRecipes();
  const problems = recipes.flatMap(recipe => recipeProblems(recipe, read));
  for (const problem of problems) out.error(problem);
  if (!problems.length) out.log(`${plural(recipes.length, 'recipe')} apply at HEAD.`);
  return problems.length ? 1 : 0;
}

export function main(argv, cwd = process.cwd(), out = console) {
  const options = parseArgs(argv);
  if (options.mode === 'help') { out.log(USAGE); return 0; }
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (options.mode === 'list') {
    for (const recipe of listRecipes()) out.log(`${recipe.name}: ${recipe.description}`);
    return 0;
  }
  if (options.mode === 'check') return checkAll(root, out);
  const { source, tests } = sourceFor(root, options);
  if (git(root, ['status', '--porcelain', '--untracked-files=no'])) out.error('Note: uncommitted changes are not part of the proof; it runs over committed HEAD.');
  const head = git(root, ['rev-parse', 'HEAD^{commit}']);
  const breakCommit = buildBreak(root, source, head);
  const sources = breakSources(root, head, breakCommit, tests);
  const { report, status } = runSquealProof(root, breakCommit, tests, sources, options.timeout);
  // Squeal reads HEAD itself: a commit between the two reads proves a different pair.
  if (report.head !== head || report.base !== breakCommit) throw new ProofError(`HEAD moved from ${head.slice(0, 12)} to ${String(report.head).slice(0, 12)} during the proof; run it again`);
  out.log(summarize(report, source.label));
  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    if (!(error instanceof ProofError)) throw error;
    console.error(`regression-proof: ${error.message}`);
    if (!process.argv.includes('--help')) console.error(`Run with --help for usage.`);
    process.exitCode = 2;
  }
}

