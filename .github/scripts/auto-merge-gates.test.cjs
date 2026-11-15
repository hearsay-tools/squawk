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
// Configs that Vitest, Vite, tsc, oxlint, ast-grep and Squeal load by default.
const TOOL_CONFIG = /(?:^|\/)(?:vitest(?:\.[\w-]+)?\.config\.[cm]?[jt]s|vitest\.setup\.ts|vite\.config\.ts|tsconfig[\w.-]*\.json|\.oxlintrc\.json|sgconfig\.yml|squeal\.config\.json)$/;
// The tests that hold the policy in place.
const POLICY_TESTS = ['.github/scripts/auto-merge-gates.test.cjs', '.github/scripts/auto-merge-admission.test.cjs'];
// A module specifier: static and dynamic import, export from, require and require.resolve.
const SPECIFIER = /(?:\bfrom|\bimport|\bimport\s*\(|\brequire(?:\.resolve)?\s*\()\s*(['"])(\.{1,2}\/[^'"\n]+)\1/g;
// A path in a string literal: a setup file, a reporter, a file a script reads.
const LITERAL = /(['"`])([\w.@-][^'"`\s$*{}<>|;]*\/[^'"`\s$*{}<>|;]*|\.{1,2}\/[^'"`\s$*{}<>|;]+)\1/g;
// The string arguments of path.join/resolve, joined: join(root, '.github', 'x.json').
const JOIN = /\b(?:join|resolve)\(([^()]*)\)/g;
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];
// Files whose code runs: the scan follows what they load and read. Data files (JSON, YAML)
// name the files a gate checks, so the scan does not follow them.
const FOLLOWED = /\.(?:[cm]?[jt]sx?|sh|ps1)$/;
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
  'upstream-scan.yml': 'opens upstream drift pull requests',
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
  'e2e-spec-map.yml': 'maps browser specs to the source they cover',
  'test-env-windows.yml': 'probes the Windows test environment',
};

// Each entry stops the scan: it records the file and does not follow what it loads.
const NOT_A_GATE = [
  { match: PRODUCT, reason: 'product source: the subject the gates check; tests, typecheck and lint cover it' },
  { match: MOCK, reason: 'runner mock: a test double; like a test file, the content rules guard it' },
  { glob: '{README.md,.env.example,**/*.md}', reason: 'documentation; .env.example has its own content rule' },
  { glob: '.github/scripts/squeal-ref-warning.cjs', reason: 'warns about a missing Squeal ref; the step may fail and no required check needs its job' },
  { glob: 'packages/desktop/**', reason: 'desktop app build; the desktop workflows are not required checks' },
  { glob: 'packages/cezar/scripts/benchmark-*', reason: 'benchmark run by hand' },
  { glob: 'packages/cezar/scripts/record-mock-wires.mjs', reason: 'records mock wire files by hand' },
  { glob: 'scripts/dev.mjs', reason: 'local development server' },
  { glob: 'scripts/setup-merge-drivers.mjs', reason: 'local git configuration' },
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

// Every repository file a gate file loads or names by path: its imports, the
// literal paths it reads, runs or hands to a tool, and joined path segments.
function references(files, file, text = read(file)) {
  const found = new Set();
  const unresolved = [];
  const inRepo = (candidate) => [path.posix.join(path.posix.dirname(file), candidate), candidate]
    .map((p) => path.posix.normalize(p).replace(/^\.\//, '')).find((p) => files.has(p));
  for (const [, , specifier] of text.matchAll(SPECIFIER)) {
    const target = resolveModule(files, file, specifier);
    if (target) found.add(target);
    else unresolved.push(`${file}: ${specifier}`);
  }
  for (const [, , literal] of text.matchAll(LITERAL)) {
    const target = (literal.startsWith('.') && resolveModule(files, file, literal)) || inRepo(literal);
    if (target) found.add(target);
  }
  if (/\.(?:sh|ps1)$/.test(file)) {
    for (const [token] of text.matchAll(/[\w.@-]*\/[\w.@/-]+/g)) {
      const target = inRepo(token);
      if (target) found.add(target);
    }
  }
  for (const [, args] of text.matchAll(JOIN)) {
    const parts = [...args.matchAll(/(['"`])([^'"`$]*)\1/g)].map(([, , part]) => part);
    const target = parts.length > 0 && inRepo(parts.join('/'));
    if (target) found.add(target);
  }
  found.delete(file);
  return { found, unresolved };
}

async function followReferences({ files, refs, refer }) {
  const followed = (f) => FOLLOWED.test(f) && !TEST_ONLY.test(f) && !notAGate(f);
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
    'packages/cezar/src/core/agent-runner.ts']) {
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
