import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { availableParallelism, loadavg as osLoadavg, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { oxlintBin } from '../src/lint/run.ts';
import { RULES } from '../src/lint/plugin.ts';
import { repoRoot } from '../src/lint/source-rule.ts';
import { PROCESS_OWNER_RULES } from '../src/lint/owner-process-rules.ts';
import { STATE_OWNER_RULES } from '../src/lint/owner-state-rules.ts';
import { READER_OWNER_RULES } from '../src/lint/owner-reader-rules.ts';
import { activeRunWriteRules } from '../src/lint/active-run-write.ts';
import { gitEnv, gitSync } from '../src/git-command.ts';
import { type CompareRound, compareReport, lintedFiles, rootRelativePaths, ruleTimings } from './profile-lint-compare.ts';

/**
 * Measures what the `cez` oxlint plugin costs (hearsay-tools/squawk#3774). A developer tool, not a
 * test: its numbers depend on the host and its load, so it prints `/proc/loadavg` beside each run.
 *
 *   node packages/cezar/scripts/profile-lint.ts [--alone] [--families] [--runs N] [path...]
 *   node packages/cezar/scripts/profile-lint.ts --compare <ref|config> [--runs N] [path...]
 *
 * It runs `oxlint -c <config> <path...>` (default path `packages`) from the repository root with
 * these configs, each written to a scratch directory:
 *   builtins   `.oxlintrc.json` without `jsPlugins` and without any `cez/*` rule;
 *   load       built-ins plus a plugin that imports the `cez` plugin and runs one rule with no visitor;
 *   transport  the same rule visiting `Program` and `CallExpression` with no-op functions, so oxlint
 *              sends every file's tree to JS and walks it;
 *   full       `.oxlintrc.json` as it is.
 * `--families` adds one run per rule family and `--alone` one run per rule: built-ins plus that
 * rule or family. Each run's user and system CPU come from the shell's `times` for its child.
 * Last, it runs the full config once with `--debug timings` and lists oxlint's own JS time per rule
 * (visitor and `create` time only; tree transfer, walking and garbage collection are not in it).
 *
 * `--compare` measures a base against the working tree in N alternating rounds (default 5); see
 * `profile-lint-compare.ts` for the report. A base that names an existing file is an oxlint config,
 * linted over the working tree. Any other base is a commit: its tree is extracted with `git archive`
 * and linted with its own `.oxlintrc.json`, because the rules locate files relative to their own
 * repository root. Both sides use the working tree's oxlint binary.
 */

interface Measure { label: string; user: number; sys: number; wall: number; load: string }

export interface ProfileOptions { paths: string[]; runs: number; alone: boolean; families: boolean; compare?: string }

/** The value after `flag`, or undefined without the flag; a flag with no value throws. */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

/** `--runs N`: a positive integer, or the statistics describe no run at all. */
function roundCount(value: string): number {
  const count = Number(value);
  if (!/^\d+$/.test(value) || count < 1) throw new Error(`--runs needs a positive integer, not ${value}`);
  return count;
}

/** The command line: flags, `--runs N`, `--compare <ref|config>`, and the paths to lint (default `packages`). */
export function profileArgs(args: readonly string[]): ProfileOptions {
  const runs = flagValue(args, '--runs');
  const compare = flagValue(args, '--compare');
  const values = new Set(['--runs', '--compare'].map(flag => args.indexOf(flag) + 1).filter(index => index > 0));
  const paths = args.filter((arg, index) => !arg.startsWith('--') && !values.has(index));
  return {
    paths: paths.length > 0 ? paths : ['packages'],
    runs: runs === undefined ? (compare === undefined ? 1 : 5) : roundCount(runs),
    alone: args.includes('--alone'),
    families: args.includes('--families'),
    ...(compare === undefined ? {} : { compare }),
  };
}

// The test imports `profileArgs`; only a direct run reads the command line, inside its error handler.
let paths: string[] = [];
let runs = 1;
let alone = false;
let byFamily = false;
let compare: string | undefined;

function readCommandLine(): void {
  const options = profileArgs(process.argv.slice(2));
  paths = rootRelativePaths(options.paths, repoRoot);
  ({ runs, alone, families: byFamily, compare } = options);
}

const base = JSON.parse(readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8')) as { jsPlugins?: string[]; rules: Record<string, unknown> };
const pluginPath = resolve(repoRoot, base.jsPlugins?.[0] ?? 'packages/cezar/src/lint/plugin.ts');
const builtinRules = Object.fromEntries(Object.entries(base.rules).filter(([name]) => !name.startsWith('cez/')));
let scratch = '';

const loadavg = () => osLoadavg().map(value => value.toFixed(2)).join(' ');
const oneMinute = () => osLoadavg()[0] ?? Number.NaN;
const seconds = (text: string) => {
  const match = /^(\d+)m([\d.]+)s$/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
};

function writeConfig(name: string, plugins: string[], rules: Record<string, unknown>): string {
  const file = join(scratch, `${name}.json`);
  const { $schema: _schema, ...rest } = base as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...rest, jsPlugins: plugins, rules: { ...builtinRules, ...rules } }));
  return file;
}

function noopPlugin(name: string, visitors: string[]): string {
  const file = join(scratch, `${name}.mjs`);
  const body = visitors.map(type => `${type}() {}`).join(', ');
  writeFileSync(file, [
    `import ${JSON.stringify(pluginPath)};`,
    `export default { meta: { name: 'noop' }, rules: { noop: { create() { return { ${body} }; } } } };`,
  ].join('\n'));
  return file;
}

/** One oxlint run; `times` in a POSIX shell reports the CPU its children used. */
function measure(label: string, config: string, cwd = repoRoot): Measure {
  const load = loadavg();
  const started = performance.now();
  const shell = spawnSync('/bin/sh', ['-c', '"$@" >/dev/null 2>&1; times', 'sh', process.execPath, oxlintBin(), '-c', config, ...paths], { cwd, encoding: 'utf8' });
  const wall = (performance.now() - started) / 1000;
  const [user = '', sys = ''] = (shell.stdout.trim().split('\n').at(-1) ?? '').split(/\s+/);
  return { label, user: seconds(user), sys: seconds(sys), wall, load };
}

function best(label: string, config: string): Measure {
  const all = Array.from({ length: runs }, () => measure(label, config));
  return all.reduce((low, next) => (next.user < low.user ? next : low));
}

const enabled = (names: string[]) => Object.fromEntries(names.map(name => [`cez/${name}`, 'error']));
const families: Record<string, string[]> = {
  'owner-process': PROCESS_OWNER_RULES.map(rule => rule.name),
  'owner-state': STATE_OWNER_RULES.map(rule => rule.name),
  'owner-reader': READER_OWNER_RULES.map(rule => rule.name),
  'active-run-write': activeRunWriteRules.map(rule => rule.name),
};

function main(): void {
  const results: Measure[] = [];
  const row = (m: Measure) => `| ${m.label} | ${m.user.toFixed(2)} | ${m.sys.toFixed(2)} | ${m.wall.toFixed(2)} | ${m.load} |`;
  const add = (m: Measure) => { results.push(m); console.error(row(m)); };
  const plugin = (name: string) => [noopPlugin(name, name === 'load' ? [] : ['Program', 'CallExpression'])];
  add(best('builtins', writeConfig('builtins', [], {})));
  add(best('load', writeConfig('load', plugin('load'), { 'noop/noop': 'error' })));
  add(best('transport', writeConfig('transport', plugin('transport'), { 'noop/noop': 'error' })));
  add(best('full', join(repoRoot, '.oxlintrc.json')));
  if (byFamily) for (const [name, rules] of Object.entries(families)) add(best(`family ${name}`, writeConfig(`family-${name}`, [pluginPath], enabled(rules))));
  if (alone) for (const rule of RULES) add(best(`cez/${rule.name}`, writeConfig(`rule-${rule.name}`, [pluginPath], enabled([rule.name]))));
  console.log(`Command: oxlint -c <config> ${paths.join(' ')} (cwd ${repoRoot}); best of ${runs}; CPU in seconds.\n`);
  console.log('| Config | User | Sys | Wall | Load (1/5/15 min) |\n| --- | ---: | ---: | ---: | --- |');
  for (const m of results) console.log(row(m));
  const lines = timingsOutput('.oxlintrc.json').split('\n').filter(line => line.startsWith('cez/'));
  console.log(`\nOxlint's JS time per rule (\`--debug timings\`, load ${loadavg()}):\n\n| Rule | ms | Calls |\n| --- | ---: | ---: |`);
  for (const line of lines) {
    const [name, ms, , calls] = line.split(/\s+/);
    console.log(`| ${name} | ${Number(ms).toFixed(0)} | ${calls} |`);
  }
}

/** Oxlint's `--debug timings` output for one run; lint findings make it exit 1, which is not a failure here. */
function timingsOutput(config: string, cwd = repoRoot): string {
  const run = spawnSync(process.execPath, [oxlintBin(), '-c', config, '-f', 'default', '--debug', 'timings', ...paths], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.status !== 0 && run.status !== 1) throw new Error(`oxlint --debug timings exited ${run.status}: ${run.stderr}`);
  return run.stdout;
}

interface Side { config: string; cwd: string }

/** The base side: an existing file is a config over the working tree; anything else is a commit's own tree. */
function baseSide(arg: string): { side: Side; describe: string } {
  const file = resolve(arg);
  if (existsSync(file)) return { side: { config: file, cwd: repoRoot }, describe: `config ${arg}` };
  // The git helpers drop inherited `GIT_DIR`-style variables (a hook, `rebase --exec`), so git acts on `cwd`.
  let sha: string;
  try {
    sha = gitSync(['rev-parse', '--verify', '--quiet', `${arg}^{commit}`], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error(`--compare ${arg}: not a file and not a commit`);
  }
  const tree = join(scratch, 'base');
  mkdirSync(tree);
  execFileSync('/bin/sh', ['-c', 'git archive "$1" | tar -x -C "$2"', 'sh', sha, tree], { cwd: repoRoot, env: gitEnv() });
  // Oxlint applies the `.gitignore` of an enclosing repository. A temp directory inside an ignored
  // path (a task's TMPDIR) would hide every file, so the tree gets a repository boundary of its own.
  gitSync(['init', '--quiet', tree]);
  for (const dir of ['.', ...readdirSync(join(repoRoot, 'packages')).map(name => join('packages', name))]) {
    const modules = join(repoRoot, dir, 'node_modules');
    if (existsSync(modules) && existsSync(join(tree, dir)) && !existsSync(join(tree, dir, 'node_modules'))) symlinkSync(modules, join(tree, dir, 'node_modules'), 'dir');
  }
  return { side: { config: join(tree, '.oxlintrc.json'), cwd: tree }, describe: `commit ${arg} (${sha.slice(0, 9)})` };
}

/** One side's per-rule JS time. A side that lints no files fails: a CPU time from that run measures nothing. */
function sideTimings(label: string, side: Side): Record<string, number> {
  const output = timingsOutput(side.config, side.cwd);
  if (!lintedFiles(output)) throw new Error(`${label}: oxlint linted no files for ${paths.join(' ')} in ${side.cwd}`);
  return ruleTimings(output);
}

function compareMain(arg: string): void {
  const { side: base, describe } = baseSide(arg);
  const candidate: Side = { config: join(repoRoot, '.oxlintrc.json'), cwd: repoRoot };
  const rounds: CompareRound[] = [];
  for (let round = 1; round <= runs; round++) {
    const loads = [oneMinute()];
    const baseRun = measure('base', base.config, base.cwd);
    loads.push(oneMinute());
    const candidateRun = measure('candidate', candidate.config, candidate.cwd);
    const baseTimings = sideTimings('base', base);
    const candidateTimings = sideTimings('candidate', candidate);
    rounds.push({ loads, base: baseRun, candidate: candidateRun, baseTimings, candidateTimings });
    const [baseLoad = Number.NaN, candidateLoad = Number.NaN] = loads;
    console.error(`round ${round}/${runs}: base ${baseRun.user.toFixed(2)} s user at load ${baseLoad.toFixed(2)}, candidate ${candidateRun.user.toFixed(2)} s user at load ${candidateLoad.toFixed(2)}`);
  }
  console.log(compareReport({ base: describe, command: `oxlint -c <config> ${paths.join(' ')}`, rounds, cores: availableParallelism() }));
}

if (import.meta.main) {
  scratch = mkdtempSync(join(tmpdir(), 'cez-profile-lint-'));
  try {
    readCommandLine();
    if (compare === undefined) main();
    else compareMain(compare);
  } catch (error) {
    console.error(`profile-lint: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
