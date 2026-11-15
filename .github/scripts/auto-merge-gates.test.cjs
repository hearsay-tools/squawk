'use strict';
// Every script or config a workflow or npm script runs is either on the auto-merge
// never-list (.ai/skills/auto-merge/check.mjs) or named below as not a gate.
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
// A relative path in a string literal: an import, a setup file, a reporter, a script a config runs.
const RELATIVE = /(['"`])(\.{1,2}\/[^'"`\s$*{}]+)\1/g;
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
};

const NOT_A_GATE = [
  { glob: '.github/scripts/squeal-ref-warning.cjs', reason: 'warns about a missing Squeal ref; the step may fail and no required check needs its job' },
  { glob: '.github/scripts/test-env-windows-probe.ps1', reason: 'Windows test-env probe; test-env-windows.yml is not a required check' },
  { glob: 'packages/desktop/**', reason: 'desktop app build; the desktop workflows are not required checks' },
  { glob: 'packages/cezar/scripts/benchmark-*', reason: 'benchmark run by hand' },
  { glob: 'packages/cezar/scripts/record-mock-wires.mjs', reason: 'records mock wire files by hand' },
  { glob: 'scripts/dev.mjs', reason: 'local development server' },
  { glob: 'scripts/setup-merge-drivers.mjs', reason: 'local git configuration' },
  { glob: 'scripts/test-parity.mjs', reason: 'local parity runner; CI runs the parity tests through Vitest' },
  { glob: 'vitest.stryker.config.ts', reason: 'Vitest config for mutation runs, which only report' },
  { glob: '.github/{test-durations,cockpit-test-durations}.json', reason: 'shard timings; the sequencers balance shards with them and select no test by them' },
  { glob: 'packages/{cezar/src/server/app-type.ts,api-client/src/index.ts}', reason: 'product source that a tsconfig path maps a package name to' },
  { glob: 'packages/cezar/src/{detached-process,runs/run-exits,core/agent-runner,home/identity,home/home,home/store,home/file-location}.ts', reason: 'product module that a harness, lint rule or release script imports; it decides no check result' },
];

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
      if (!token.startsWith('/') && SCOPE.test(target)) for (const file of matching(target)) refer(file, source);
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

// A guarded file's relative imports and paths are gates too, wherever they live.
function resolveRelative(files, from, specifier) {
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return [target, target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx')].find((f) => files.has(f));
}

async function followReferences({ files, refs, refer }) {
  const { neverRule, TEST_FILE } = await policy;
  const followed = (f) => neverRule(f) && !TEST_FILE.test(f) && /\.(?:[cm]?[jt]sx?|json)$/.test(f);
  const queue = [...refs.keys()].filter(followed);
  const seen = new Set(queue);
  while (queue.length > 0) {
    const file = queue.pop();
    for (const [, , specifier] of read(file).matchAll(RELATIVE)) {
      const target = resolveRelative(files, file, specifier);
      if (!target) continue;
      refer(target, `referenced by ${file}`);
      if (!seen.has(target) && followed(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
}

async function discover() {
  const found = scan();
  await followReferences(found);
  return found;
}

test('every gate file a workflow or npm script runs is on the auto-merge never-list', async () => {
  const { neverRule, TEST_FILE } = await policy;
  const found = await discover();
  for (const gate of ['.github/scripts/check-clones.cjs', 'packages/cezar/src/lint/run.ts', '.github/actions/node-dist/action.yml', 'scripts/test-home-env.mjs', '.oxlintrc.json', 'vitest.config.ts', '.github/scripts/vitest-worker-count.cjs',
    'scripts/test-browser-home-env.mjs', 'packages/web/product-identity.ts']) {
    assert.ok(found.refs.has(gate), `the scan no longer finds ${gate}`);
  }
  const unguarded = [...found.refs]
    .filter(([file]) => !neverRule(file) && !TEST_FILE.test(file) && !NOT_A_GATE.some((entry) => path.matchesGlob(file, entry.glob)))
    .map(([file, sources]) => `${file} (run by ${[...sources].join(', ')})`);
  assert.deepEqual(unguarded, [], 'add each file to NEVER in check.mjs, or to NOT_A_GATE here with a reason');
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
  for (const { glob, reason } of NOT_A_GATE) {
    assert.ok(reason, glob);
    assert.ok([...refs.keys()].some((file) => path.matchesGlob(file, glob)), `${glob} matches nothing a workflow or npm script runs`);
  }
});
