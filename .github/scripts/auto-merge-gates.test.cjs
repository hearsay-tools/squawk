'use strict';
// Every gate file is on the auto-merge never-list (.ai/skills/auto-merge/check.mjs) or
// named below as not a gate, with a reason.
//
// Gate code: .github/, scripts/, .ai/, packages/*/scripts except runner mocks,
// packages/cezar/src/lint, the packages/web/e2e harness, tool configs, and testkits a
// gate imports. The scan starts at workflow steps, npm scripts and tool configs, and
// follows every file gate code loads, reads or runs, transitively.
//
// The scan stops at product source (packages/*/src outside lint), runner mocks and
// docs: it records them, does not follow them, and NOT_A_GATE names each with one
// reason. Product files a lint rule reads as data (core/agent-runner.ts,
// core/runner-facts.ts, contract/src/runner.ts) are product: changing them changes
// what the lint checks, not how strong it is.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../..');
const policy = import(pathToFileURL(path.join(root, '.ai/skills/auto-merge/check.mjs')).href);
const SCOPE = /^(?:\.github\/|scripts\/|\.ai\/|packages\/[^/]+\/scripts\/|packages\/cezar\/src\/lint\/)/;
// Configs that Vitest, Vite, tsc, oxlint and Squeal load by default.
const TOOL_CONFIG = /(?:^|\/)(?:vitest(?:\.[\w-]+)?\.config\.[cm]?[jt]s|vitest\.setup\.ts|vite\.config\.ts|tsconfig[\w.-]*\.json|\.oxlintrc\.json|squeal\.config\.json)$/;
// The tests that hold the policy in place.
const POLICY_TESTS = ['.github/scripts/auto-merge-gates.test.cjs', '.github/scripts/auto-merge-admission.test.cjs'];
// A module specifier: static and dynamic import, export from, require and require.resolve.
const SPECIFIER = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire(?:\.resolve)?\s*\()\s*(['"`])(\.{1,2}\/[^'"`\n]*)\1/g;
// A computed module specifier, which the scan cannot follow.
const COMPUTED_SPECIFIER = /(?:\bimport\s*\(|\brequire(?:\.resolve)?\s*\()\s*`([^`]*\$\{[^`]*)`/g;
// A path in a string literal: a setup file, a reporter, a file a script reads.
const LITERAL = /(['"`])([\w.@-][^'"`\s$*{}<>|;]*\/[^'"`\s$*{}<>|;]*|\.{1,2}\/[^'"`\s$*{}<>|;]+)\1/g;
// The string arguments of path.join/resolve, joined: join(root, '.github', 'x.json').
const JOIN = /\b(?:join|resolve)\(([^()]*)\)/g;
// A string or a comment in code; the scan drops the comments.
const STRING_OR_COMMENT = /(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
// Shell variables the environment sets, which name no repository path.
const SHELL_ENVIRONMENT = new Set(['HOME', 'TMPDIR', 'RUNNER_TEMP', 'PWD', 'XDG_CACHE_HOME']);
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];
// Files whose code runs: the scan follows what they load and read. Data files (JSON, YAML)
// name the files a gate checks, so the scan does not follow them.
const FOLLOWED = /\.(?:[cm]?[jt]sx?|sh|ps1)$/;
const SHELL = /\.(?:sh|ps1)$/;
// A tool config in JSON or YAML: the scan follows every path it names.
const CONFIG_DATA = /\.(?:json|ya?ml)$/;
// Config keys the scan skips, with the reason each names no gate input.
const SKIPPED_KEYS = new Map([
  ['include', 'picks the files a tool checks'],
  ['exclude', 'picks the files a tool skips'],
  ['files', 'picks the files tsc checks'],
  ['rootDir', 'names the source tree tsc checks'],
  ['inputs', 'names the files a Squeal test reads, for cache keys'],
  ['cwd', 'names a working directory, which loads nothing'],
]);
// Product source is what the gates check. The scan records the product files a gate
// loads or reads, and stops there.
const PRODUCT = /^packages\/[^/]+\/src\/(?!lint\/)(?!.*\.testkit\.)/;
const MOCK = /^packages\/[^/]+\/scripts\/mock-/;
const TEST_ONLY = /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;
const CONFIG_FLAG = /(?:^|\s)--config[=\s]+([^\s'"]+)/g;
const NPM_RUN = /\bnpm\s+(?:run\s+([\w:*-]+)|(test)\b)(?:[^\n;&|]*?\s(?:-w|--workspace)[=\s]+(\S+))?/g;

const BOT_WORKFLOWS = {
  'friction-intake.yml': 'labels friction issues',
  'issue-intake.yml': 'labels new issues',
  'mutants-weekly.yml': 'reports mutation scores',
  'mutation-report.yml': 'reports mutation scores',
  'mutation-report-comment.yml': 'comments mutation scores',
  'sweep-ci-failures.yml': 'files CI failure issues',
  'report-queue-flakes.yml': 'files queue flake issues',
  'report-workflow-failure.yml': 'files workflow failure issues',
  'main-ci-escalation.yml': 'escalates a red main',
  'workaround-expiry.yml': 'files expired workaround issues',
  'refresh-test-durations.yml': 'opens a pull request with shard timings',
  'transcript-facts-responsiveness.yml': 'measures transcript lag',
  'test-env-windows.yml': 'probes the Windows test environment',
  'worker-scope-native.yml': 'probes worker process scopes in a delegated cgroup',
};

// Each entry stops the scan: it records the file and does not follow what it loads.
const NOT_A_GATE = [
  { match: PRODUCT, reason: 'product source: the subject the gates check; tests, typecheck and lint cover it' },
  { match: MOCK, reason: 'runner mock: a test double; like a test file, the content rules guard it' },
  { glob: '{README.md,.env.example,**/*.md}', reason: 'documentation; .env.example has its own content rule' },
  { glob: '.github/scripts/crap-follow-up.cjs', reason: 'files CRAP follow-ups after a merge to main; it never runs on a pull request and no required check needs it' },
  { glob: '.github/scripts/squeal-ref-warning.cjs', reason: 'warns about a missing Squeal ref; the step may fail and no required check needs its job' },
  { glob: 'packages/cezar/scripts/benchmark-*', reason: 'benchmark run by hand' },
  { glob: 'packages/cezar/scripts/record-mock-wires.mjs', reason: 'records mock wire files by hand' },
  { glob: 'scripts/dev.mjs', reason: 'local development server' },
  { glob: 'scripts/restack-after-squash.mjs', reason: 'restacks a local branch by hand; no workflow or check runs it' },
  { glob: 'scripts/test-parity.mjs', reason: 'local parity runner; CI runs the parity tests through Vitest' },
  { glob: 'vitest.stryker.config.ts', reason: 'Vitest config for mutation runs, which only report' },
  { glob: '.github/{test-durations,cockpit-test-durations}.json', reason: 'shard timings; the sequencers balance shards with them and select no test by them' },
];
const notAGate = (file) => NOT_A_GATE.some((entry) => (entry.match ? entry.match.test(file) : path.matchesGlob(file, entry.glob)));

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// A job may check the repository out into a subdirectory; paths under it are repository paths.
function checkoutDirs(job) {
  return (job.steps ?? []).filter((step) => /^actions\/checkout@/.test(step.uses ?? '') && step.with?.path)
    .map((step) => path.posix.normalize(step.with.path).replace(/\/$/, ''));
}

function stepDirectory(workflow, job, step) {
  const env = { ...workflow.env, ...job.env, ...step.env };
  return String(step['working-directory'] ?? job.defaults?.run?.['working-directory'] ?? workflow.defaults?.run?.['working-directory'] ?? '')
    .replace(/\$\{\{\s*env\.(\w+)\s*\}\}/g, (_, key) => env[key] ?? '');
}

// Records each in-scope repository file and each npm script that a command names.
function collector(files) {
  const refs = new Map();
  const npmRuns = [];
  const refer = (file, source) => refs.set(file, (refs.get(file) ?? new Set()).add(source));
  const matching = (target) => (files.has(target) ? [target]
    : [...files].filter((f) => f.startsWith(`${target}/`) || (/[*{]/.test(target) && path.matchesGlob(f, target))));
  function command(text, cwd, source, checkouts = []) {
    const inRepo = (p) => checkouts.reduce((rest, dir) => (rest === dir ? '' : rest.startsWith(`${dir}/`) ? rest.slice(dir.length + 1) : rest), p);
    const plain = text.replace(/\$\{\{[^}]*\}\}/g, '*');
    const base = inRepo(cwd);
    for (const [token] of plain.matchAll(/[\w.@*{},/-]*\/[\w.@*{},/-]*/g)) {
      const target = inRepo(path.posix.normalize(path.posix.join(base, token)).replace(/\/$/, ''));
      if (token.startsWith('/')) continue;
      if (SCOPE.test(target)) for (const file of matching(target)) refer(file, source);
      else if (files.has(target) && FOLLOWED.test(target)) refer(target, source);
    }
    for (const [, config] of plain.matchAll(CONFIG_FLAG)) {
      const target = inRepo(path.posix.normalize(path.posix.join(base, config)));
      if (files.has(target)) refer(target, source);
    }
    for (const [, run, npmTest, workspace] of plain.matchAll(NPM_RUN)) npmRuns.push({ source, cwd: base, name: run ?? npmTest, workspace });
  }
  return { refs, npmRuns, refer, command };
}

function scanWorkflow(name, command) {
  const workflow = yaml.parse(read(`.github/workflows/${name}`));
  for (const job of Object.values(workflow.jobs ?? {})) {
    if (job.uses) command(job.uses, '', name);
    const checkouts = checkoutDirs(job);
    for (const step of job.steps ?? []) {
      const cwd = stepDirectory(workflow, job, step);
      for (const text of [step.run, step.uses, step.with?.script]) if (typeof text === 'string') command(text, cwd, name, checkouts);
    }
  }
}

function scan() {
  const files = new Set(execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n').filter(Boolean));
  const packages = new Map([...files]
    .filter((f) => /^(?:packages\/[^/]+\/)?package\.json$/.test(f))
    .map((f) => [path.posix.dirname(f), JSON.parse(read(f))]));
  const found = collector(files);
  for (const name of fs.readdirSync(path.join(root, '.github/workflows'))) {
    if (!Object.hasOwn(BOT_WORKFLOWS, name)) scanWorkflow(name, found.command);
  }
  for (const [dir, manifest] of packages) {
    for (const [name, text] of Object.entries(manifest.scripts ?? {})) found.command(text, dir === '.' ? '' : dir, `${dir}/package.json ${name}`);
  }
  for (const config of files) if (TOOL_CONFIG.test(config) && !/(?:^|\/)(?:__)?fixtures(?:__)?\//.test(config)) found.refer(config, 'default tool config');
  return { files, packages, ...found };
}

// Resolves a relative module specifier as Node and TypeScript do.
// A build output path (packages/<name>/dist/...) resolves to the source tsc builds it from.
function resolveModule(files, from, specifier) {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)).replace(/\/$/, '');
  return [joined, joined.replace(/^(packages\/[^/]+)\/dist\//, '$1/src/')].flatMap((target) => [target, ...MODULE_EXTENSIONS.map((ext) => target + ext),
    target.replace(/\.([mc]?)js$/, '.$1ts'), target.replace(/\.js$/, '.tsx'), ...MODULE_EXTENSIONS.map((ext) => `${target}/index${ext}`)])
    .find((f) => files.has(f));
}

// Looks a path up as written and relative to the file that names it; with
// `directories`, a directory stands for every file in it.
function lookup(files, file) {
  const candidates = (p) => [path.posix.join(path.posix.dirname(file), p), p]
    .map((c) => path.posix.normalize(c).replace(/^\.\//, '').replace(/\/$/, ''));
  return (written, { directories = false } = {}) => {
    for (const p of candidates(written)) {
      if (files.has(p)) return [p];
      const inside = directories && p !== '.' && !p.startsWith('..') ? [...files].filter((f) => f.startsWith(`${p}/`)) : [];
      if (inside.length > 0) return inside;
    }
    return [];
  };
}

const withoutComments = (text) => text.replace(STRING_OR_COMMENT, (match) => (match.startsWith('/') ? ' ' : match));

function codeReferences(files, file, text) {
  const found = [];
  const unresolved = [];
  const find = lookup(files, file);
  const code = withoutComments(text);
  for (const [, quote, specifier] of code.matchAll(SPECIFIER)) {
    if (quote === '`' && specifier.includes('${')) continue;
    const target = resolveModule(files, file, specifier);
    if (target) found.push(target);
    else unresolved.push(`${file}: ${specifier}`);
  }
  for (const [, specifier] of code.matchAll(COMPUTED_SPECIFIER)) unresolved.push(`${file}: \`${specifier}\``);
  for (const [, , literal] of code.matchAll(LITERAL)) {
    const target = literal.startsWith('.') && resolveModule(files, file, literal);
    found.push(...(target ? [target] : find(literal)));
  }
  for (const [, args] of code.matchAll(JOIN)) {
    const parts = [...args.matchAll(/(['"`])([^'"`$]*)\1/g)].map(([, , part]) => part);
    if (parts.length > 0) found.push(...find(parts.join('/')));
  }
  return { found, unresolved };
}

// Variables a shell script sets to a repository path: its own directory, a literal
// path, or a path under such a variable. A variable built from the environment
// names no repository path.
function shellVariables(file, text) {
  const variables = new Map([['PSScriptRoot', path.posix.dirname(file)]]);
  const environment = new Set(SHELL_ENVIRONMENT);
  for (const [, name, value] of text.matchAll(/^\s*(?:export\s+)?([A-Za-z_]\w*)=(.*)$/gm)) {
    if (variables.has(name) || environment.has(name)) continue;
    const based = /\$\{?([A-Za-z_]\w*)\}?((?:\/[\w.@-]+)*)/.exec(value);
    const literal = /^["']?([\w.@-]+(?:\/[\w.@-]+)+)["']?\s*$/.exec(value);
    if (/dirname\b.*\$0/.test(value)) variables.set(name, path.posix.dirname(file));
    else if (literal) variables.set(name, path.posix.normalize(literal[1]));
    else if (based && variables.has(based[1])) variables.set(name, path.posix.normalize(variables.get(based[1]) + based[2]));
    else if (based && environment.has(based[1])) environment.add(name);
  }
  return { variables, environment };
}

function shellReferences(files, file, text) {
  const found = [];
  const unresolved = [];
  const find = lookup(files, file);
  const { variables, environment } = shellVariables(file, text);
  for (const [, name, rest] of text.matchAll(/\$\{?([A-Za-z_]\w*)\}?((?:\/[\w.@-]+)+)/g)) {
    if (variables.has(name)) found.push(...find(path.posix.normalize(variables.get(name) + rest)));
    else if (!environment.has(name)) unresolved.push(`${file}: $${name}${rest}`);
  }
  for (const [token] of text.matchAll(/(?<![\w$}])[\w.@-]*\/[\w.@/-]+/g)) found.push(...find(token));
  return { found, unresolved };
}

// Every string in a JSON or YAML tool config that names a repository file or directory.
function configReferences(files, file, text) {
  const find = lookup(files, file);
  const strings = [];
  const walk = (value) => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) if (!SKIPPED_KEYS.has(key)) walk(child);
  };
  walk(yaml.parse(file.endsWith('.json') ? withoutComments(text) : text));
  const paths = strings.filter((value) => value !== '' && !/[\s*{}]/.test(value));
  return { found: paths.flatMap((value) => find(value, { directories: true })), unresolved: [] };
}

// Every repository file a gate file loads, reads, runs or names by path.
function references(files, file, text = read(file)) {
  const kind = CONFIG_DATA.test(file) ? configReferences : SHELL.test(file) ? shellReferences : codeReferences;
  const { found, unresolved } = kind(files, file, text);
  return { found: new Set(found.filter((f) => f !== file)), unresolved };
}

async function followReferences({ files, refs, refer }) {
  const followed = (f) => (FOLLOWED.test(f) || (TOOL_CONFIG.test(f) && CONFIG_DATA.test(f))) && !TEST_ONLY.test(f) && !notAGate(f);
  const queue = [...refs.keys()].filter(followed);
  const seen = new Set(queue);
  const unresolved = [];
  while (queue.length > 0) {
    const file = queue.pop();
    const result = references(files, file);
    unresolved.push(...result.unresolved);
    for (const target of result.found) {
      refer(target, `referenced by ${file}`);
      if (!seen.has(target) && followed(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return unresolved;
}

async function discover() {
  const found = scan();
  found.unresolved = await followReferences(found);
  return found;
}

test('every gate file a workflow or npm script runs is on the auto-merge never-list', async () => {
  const { neverRule } = await policy;
  const found = await discover();
  for (const gate of ['.github/scripts/check-clones.cjs', 'packages/cezar/src/lint/run.ts', '.github/actions/node-dist/action.yml', 'scripts/test-home-env.mjs', '.oxlintrc.json', 'vitest.config.ts', '.github/scripts/vitest-worker-count.cjs',
    'scripts/test-browser-home-env.mjs', 'packages/web/product-identity.ts', 'packages/web/e2e/wait-support.ts', 'packages/web/e2e/visual-ready.ts',
    'packages/cezar/src/core/agent-runner.ts', 'packages/cezar/src/lint/owner-state-rules.ts', '.ai/scripts/e2e-served-repo.mjs']) {
    assert.ok(found.refs.has(gate), `the scan no longer finds ${gate}`);
  }
  const unguarded = [...found.refs]
    .filter(([file]) => !neverRule(file) && !TEST_ONLY.test(file) && !notAGate(file))
    .map(([file, sources]) => `${file} (run by ${[...sources].join(', ')})`);
  assert.deepEqual(unguarded, [], 'add each file to NEVER in check.mjs, or to NOT_A_GATE here with a reason');
  assert.deepEqual(found.unresolved, [], 'a gate file imports a path the scan cannot resolve');
});

test('references resolve every module specifier and path a gate file names', () => {
  const files = new Set(['g/gate.mjs', 'packages/x/src/built.ts', 'g/plain.ts', 'g/swapped.ts', 'g/dir/index.ts', 'g/lazy.cjs', 'g/resolved.mjs',
    'g/setup.mjs', 'g/data.json', 'packages/x/src/read.ts', 'g/joined/file.json', 'scripts/run.sh']);
  const text = [
    "import a from './plain'", "export { b } from './swapped.js'", "import './dir'", "const c = await import('./lazy.cjs')",
    "require.resolve('./resolved.mjs')", "setupFiles: ['./setup.mjs']", "const DEFINITION = 'packages/x/src/read.ts'",
    "readFileSync(join(root, 'g', 'joined', 'file.json'))", "new URL('./data.json', import.meta.url)", "execFileSync('sh', ['scripts/run.sh'])",
    "import built from '../packages/x/dist/built.js'", "import missing from './missing'",
  ].join('\n');
  const { found, unresolved } = references(files, 'g/gate.mjs', text);
  assert.deepEqual([...found].sort(), [...files].filter((f) => f !== 'g/gate.mjs').sort());
  assert.deepEqual(unresolved, ['g/gate.mjs: ./missing']);
});

test('references read the unquoted paths a shell script runs or sources', () => {
  const files = new Set(['s/run.sh', 's/env.sh', 'scripts/tool.mjs', 'packages/x/scripts/start.ps1']);
  const text = 'set -e\nsource ./env.sh\nnode scripts/tool.mjs --flag\npwsh -File packages/x/scripts/start.ps1\nls /tmp/out\n';
  assert.deepEqual([...references(files, 's/run.sh', text).found].sort(), ['packages/x/scripts/start.ps1', 's/env.sh', 'scripts/tool.mjs']);
});

test('references follow the files and directories a JSON tool config loads', () => {
  const files = new Set(['.oxlintrc.json', 'lint/plugin.ts', 'tsconfig.json', 'tsconfig.base.json', 'src/app.ts']);
  const oxlint = references(files, '.oxlintrc.json', '{\n  // plugins\n  "jsPlugins": ["./lint/plugin.ts"]\n}\n').found;
  assert.deepEqual([...oxlint], ['lint/plugin.ts']);
  const ts = references(files, 'tsconfig.json', '{ "extends": "./tsconfig.base.json", "include": ["src"] }').found;
  assert.deepEqual([...ts], ['tsconfig.base.json']);
});

test('references resolve the path variables a shell script sets and fail on an unknown one', () => {
  const files = new Set(['tools/run.sh', 'tools/helper.mjs', 'build/cache/out.txt', 'scripts/tool.mjs']);
  const text = [
    'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)', 'ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)', 'OUT=build/cache',
    'CACHE=${XDG_CACHE_HOME:-"$HOME/.cache"}', 'node "$SCRIPT_DIR/helper.mjs"', 'node "$ROOT/scripts/tool.mjs"', 'cat "$OUT/out.txt"',
    'ls "$CACHE/tools"', 'ls "$HOME/.config"', 'node "$UNKNOWN/thing.mjs"',
  ].join('\n');
  const { found, unresolved } = references(files, 'tools/run.sh', text);
  assert.deepEqual([...found].sort(), ['build/cache/out.txt', 'scripts/tool.mjs', 'tools/helper.mjs']);
  assert.deepEqual(unresolved, ['tools/run.sh: $UNKNOWN/thing.mjs']);
});

test('references see specifiers behind comments and in templates, and fail on a computed one', () => {
  const files = new Set(['g/gate.mjs', 'g/a.cjs', 'g/b.mjs', 'g/c.mjs']);
  const text = 'require(/* c */ "./a.cjs")\nimport v from /* c */ "./b.mjs"\nawait import(`./c.mjs`)\n// import gone from "./gone.mjs"\nawait import(`./${name}.mjs`)\n';
  const { found, unresolved } = references(files, 'g/gate.mjs', text);
  assert.deepEqual([...found].sort(), ['g/a.cjs', 'g/b.mjs', 'g/c.mjs']);
  assert.deepEqual(unresolved, ['g/gate.mjs: `./${name}.mjs`']);
});

test('the tests that hold the policy are themselves guarded against any edit', async () => {
  const { neverRule } = await policy;
  for (const file of POLICY_TESTS) {
    const rule = neverRule(file);
    assert.ok(rule && !rule.unless, `${file} must be on the never-list without an unless rule`);
  }
});

test('every npm script a workflow or package script runs exists', () => {
  const { packages, npmRuns } = scan();
  const byName = new Map([...packages.values()].map((manifest) => [manifest.name, manifest]));
  const missing = npmRuns.filter(({ cwd, name, workspace }) => {
    const manifest = workspace ? byName.get(workspace) : packages.get(cwd || '.');
    return !Object.keys(manifest?.scripts ?? {}).some((script) => path.matchesGlob(script, name));
  }).map(({ source, name, workspace }) => `${source}: npm run ${name}${workspace ? ` -w ${workspace}` : ''}`);
  assert.ok(npmRuns.some(({ name }) => name === 'lint'), 'the scan no longer finds npm run lint');
  assert.deepEqual(missing, []);
});

test('each exemption has a reason and still matches what CI runs', async () => {
  const { refs } = await discover();
  for (const [name, reason] of Object.entries(BOT_WORKFLOWS)) {
    assert.ok(reason && fs.existsSync(path.join(root, '.github/workflows', name)), name);
  }
  for (const entry of NOT_A_GATE) {
    const name = entry.glob ?? String(entry.match);
    const matches = (file) => (entry.match ? entry.match.test(file) : path.matchesGlob(file, entry.glob));
    assert.ok(entry.reason, name);
    assert.ok([...refs.keys()].some(matches), `${name} matches nothing a workflow or npm script runs`);
  }
});
