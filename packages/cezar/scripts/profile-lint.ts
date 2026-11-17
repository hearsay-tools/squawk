import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { oxlintBin } from '../src/lint/run.ts';
import { RULES } from '../src/lint/plugin.ts';
import { repoRoot } from '../src/lint/source-rule.ts';
import { PROCESS_OWNER_RULES } from '../src/lint/owner-process-rules.ts';
import { STATE_OWNER_RULES } from '../src/lint/owner-state-rules.ts';
import { READER_OWNER_RULES } from '../src/lint/owner-reader-rules.ts';
import { activeRunWriteRules } from '../src/lint/active-run-write.ts';

/**
 * Measures what the `cez` oxlint plugin costs (hearsay-tools/squawk#3774). A developer tool, not a
 * test: its numbers depend on the host and its load, so it prints `/proc/loadavg` beside each run.
 *
 *   node packages/cezar/scripts/profile-lint.ts [--alone] [--families] [--runs N] [path...]
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
 */

interface Measure { label: string; user: number; sys: number; wall: number; load: string }

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const runsIndex = args.indexOf('--runs');
const runs = runsIndex >= 0 ? Number(args[runsIndex + 1]) : 1;
const paths = args.filter((arg, index) => !arg.startsWith('--') && (runsIndex < 0 || index !== runsIndex + 1));
if (paths.length === 0) paths.push('packages');

const base = JSON.parse(readFileSync(join(repoRoot, '.oxlintrc.json'), 'utf8')) as { jsPlugins?: string[]; rules: Record<string, unknown> };
const pluginPath = resolve(repoRoot, base.jsPlugins?.[0] ?? 'packages/cezar/src/lint/plugin.ts');
const builtinRules = Object.fromEntries(Object.entries(base.rules).filter(([name]) => !name.startsWith('cez/')));
const scratch = mkdtempSync(join(tmpdir(), 'cez-profile-lint-'));

const loadavg = () => (existsSync('/proc/loadavg') ? readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ') : 'n/a');
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
function measure(label: string, config: string): Measure {
  const load = loadavg();
  const started = performance.now();
  const shell = spawnSync('/bin/sh', ['-c', '"$@" >/dev/null 2>&1; times', 'sh', process.execPath, oxlintBin(), '-c', config, ...paths], { cwd: repoRoot, encoding: 'utf8' });
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
  if (flag('--families')) for (const [name, rules] of Object.entries(families)) add(best(`family ${name}`, writeConfig(`family-${name}`, [pluginPath], enabled(rules))));
  if (flag('--alone')) for (const rule of RULES) add(best(`cez/${rule.name}`, writeConfig(`rule-${rule.name}`, [pluginPath], enabled([rule.name]))));
  console.log(`Command: oxlint -c <config> ${paths.join(' ')} (cwd ${repoRoot}); best of ${runs}; CPU in seconds.\n`);
  console.log('| Config | User | Sys | Wall | Load (1/5/15 min) |\n| --- | ---: | ---: | ---: | --- |');
  for (const m of results) console.log(row(m));
  const timings = execFileSync(process.execPath, [oxlintBin(), '-c', '.oxlintrc.json', '-f', 'default', '--debug', 'timings', ...paths], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = timings.split('\n').filter(line => line.startsWith('cez/'));
  console.log(`\nOxlint's JS time per rule (\`--debug timings\`, load ${loadavg()}):\n\n| Rule | ms | Calls |\n| --- | ---: | ---: |`);
  for (const line of lines) {
    const [name, ms, , calls] = line.split(/\s+/);
    console.log(`| ${name} | ${Number(ms).toFixed(0)} | ${calls} |`);
  }
}

try {
  main();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
