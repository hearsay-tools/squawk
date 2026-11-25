import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { Home } from '../../src/home/home.ts';
import { hasRunnerFolderEscapeBaselineEntries } from '../../src/lint/runner-folder-escape.ts';
import { bundledRunnerIds } from '../../src/plugin/bundled-runners.ts';
import { projectPaths } from '../../src/project-paths.ts';
import { readPersistedRuns } from '../../src/runs/run-store.testkit.ts';

const execFile = promisify(execFileCallback);
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = resolve(packageDir, '../..');
const wrapperPath = resolve(dirname(fileURLToPath(import.meta.url)), 'support/hsq-without-bundled.mjs');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// bound: npm pack + npm install of the release tarball must terminate.
const PACK_TIMEOUT_MS = 120_000;
// bound: one wrapped CLI command or dry-run task must terminate.
const CLI_TIMEOUT_MS = 60_000;

interface PluginsJson {
  folders: string[];
  loaded: Array<{ name: string; source: string; path: string; contributions: { runners: string[]; cliCommands: string[] } }>;
  failed: Array<{ name: string; source: string; path: string; reason: string; error: string }>;
}

/** Fail if `dir` or any directory above it contains (or is) a `node_modules` folder. */
export function assertNoNodeModulesAncestor(dir: string): void {
  let current = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  while (true) {
    assert.notEqual(basename(current), 'node_modules', `Plugin folder sits inside node_modules: ${current}`);
    const candidate = join(current, 'node_modules');
    assert.equal(existsSync(candidate), false, `Found node_modules above plugin folder: ${candidate}`);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Enforce the A3 baseline contract: baselined runners must fail; unbaselined runners must pass. */
export function assertCopyOutOutcome(
  runnerId: string,
  outcome: { ok: boolean; detail: string },
  expectsFailure: boolean,
): void {
  if (expectsFailure) {
    assert.equal(
      outcome.ok,
      false,
      `Runner "${runnerId}" still has entries in its runner-folder-escape baseline, so its copy-out dry run was expected to fail, but it passed. Empty its baseline if it is now self-contained.`,
    );
    return;
  }
  assert.equal(
    outcome.ok,
    true,
    `Runner "${runnerId}" has an empty runner-folder-escape baseline and must complete its copy-out dry run cleanly:\n${outcome.detail}`,
  );
}

function cleanChildEnv(homeDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      !['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID', 'NODE_OPTIONS', 'NODE_PATH'].includes(name)
      && !name.startsWith('STRYKER_')
      && !name.startsWith('CEZ_')
      && !name.startsWith('HSQ_')),
  );
  return { ...base, NODE_OPTIONS: '', NODE_PATH: '', HSQ_HOME: homeDir, ...extra };
}

async function runWrapped(
  packageRoot: string,
  homeDir: string,
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFile(
      process.execPath,
      [wrapperPath, '--package-root', packageRoot, '--', ...args],
      { cwd, env: cleanChildEnv(homeDir, extraEnv), timeout: CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const err = error as { code?: unknown; stdout?: string; stderr?: string };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(error),
    };
  }
}

async function installTarball(root: string): Promise<string> {
  const packDir = join(root, 'pack');
  await mkdir(packDir);
  const packed = await execFile(
    npm,
    ['pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
    { cwd: packageDir, timeout: PACK_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
  );
  const record = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0];
  assert.ok(record, 'npm pack should describe the generated tarball');

  const consumerDir = join(root, 'consumer');
  await mkdir(consumerDir);
  await writeFile(join(consumerDir, 'package.json'), '{"private":true}\n', 'utf8');
  await execFile(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', join(packDir, record.filename)],
    { cwd: consumerDir, timeout: PACK_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
  );
  return join(consumerDir, 'node_modules', '@wjarka', 'cezarion');
}

async function initFixtureRepo(repoDir: string, runnerIds: readonly string[]): Promise<void> {
  await mkdir(join(repoDir, '.ai/squawk/workflows'), { recursive: true });
  await execFile('git', ['init', '--initial-branch=main'], { cwd: repoDir });
  await writeFile(join(repoDir, 'README.md'), '# Copy-out fixture\n', 'utf8');
  for (const id of runnerIds) {
    const yaml = `name: copy-out-${id}\ndescription: Copy-out dry run for ${id}\nsteps:\n  - id: work\n    name: Work\n    runner: ${id}\n    prompt: "{{task}}"\n`;
    await writeFile(join(repoDir, '.ai/squawk/workflows', `copy-out-${id}.yaml`), yaml, 'utf8');
  }
  await execFile('git', ['add', '.'], { cwd: repoDir });
  await execFile(
    'git',
    ['-c', 'user.name=Squawk CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'fixture'],
    { cwd: repoDir },
  );
}

test('assertNoNodeModulesAncestor fails when a node_modules folder exists above the plugin folder', async () => {
  const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cezar-nm-guard-'));
  try {
    const pluginDir = join(root, 'nested', 'config', 'plugins', 'runner');
    await mkdir(pluginDir, { recursive: true });
    assertNoNodeModulesAncestor(pluginDir);
    await mkdir(join(root, 'node_modules'));
    assert.throws(() => assertNoNodeModulesAncestor(pluginDir), /Found node_modules above plugin folder/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('assertCopyOutOutcome fails when a baselined runner passes or an unbaselined runner fails', () => {
  assert.doesNotThrow(() => assertCopyOutOutcome('claude', { ok: false, detail: 'missing mock' }, true));
  assert.doesNotThrow(() => assertCopyOutOutcome('claude', { ok: true, detail: '' }, false));
  assert.throws(() => assertCopyOutOutcome('claude', { ok: true, detail: '' }, true), /expected to fail/);
  assert.throws(() => assertCopyOutOutcome('claude', { ok: false, detail: 'boom' }, false), /must complete[\s\S]*boom/);
});

test('copied dist/runners folders run without bundled runners and follow A3 baselines', { timeout: 240_000 }, async () => {
  // Keep every sandbox root under /tmp so no repository node_modules sits above the plugin folder.
  const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cezar-runner-copy-out-'));
  assert.ok(!realpathSync(root).startsWith(realpathSync(repoRoot) + sep));

  try {
    const packageRoot = await installTarball(root);
    const installedRunnersDir = join(packageRoot, 'dist/runners');
    const expectedRunnerIds = bundledRunnerIds();
    assert.ok(expectedRunnerIds.length > 0, 'checkout should ship bundled runners');
    const runnerIds = bundledRunnerIds(installedRunnersDir);
    assert.deepEqual(runnerIds, expectedRunnerIds, 'installed tarball should ship every bundled runner folder');

    // 1. Verify the wrapper boots once without bundled runners and the CLI reuses that boot.
    const probeHomeDir = join(root, 'probe-home');
    const probeHome = Home.sandbox(probeHomeDir);
    const probePluginDir = join(probeHome.plugins, 'boot-probe');
    await mkdir(probePluginDir, { recursive: true });
    await writeFile(
      join(probePluginDir, 'index.mjs'),
      `export default function setup(api) {
  api.registerCliCommand({ name: 'boot-probe', usage: [], parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none', load: async () => async () => 0 });
}
`,
      'utf8',
    );
    assertNoNodeModulesAncestor(probePluginDir);
    const probeRes = await runWrapped(packageRoot, probeHomeDir, root, ['plugins', '--json']);
    assert.equal(probeRes.code, 0, probeRes.stderr);
    const probeReport = JSON.parse(probeRes.stdout) as PluginsJson;
    assert.equal(probeReport.folders.length, 2, 'CLI bootRuntime should reuse wrapper boot without re-reading plugin folders');
    assert.deepEqual(probeReport.loaded.filter(p => p.source === 'bundled'), []);
    assert.deepEqual(probeReport.failed, []);
    assert.equal(probeReport.loaded.length, 1);
    assert.equal(probeReport.loaded[0]?.name, 'boot-probe');
    assert.equal(probeReport.loaded[0]?.source, 'host');
    assert.deepEqual(probeReport.loaded[0]?.contributions.cliCommands, ['boot-probe']);

    // 2. Copy all installed dist/runners/<id>/ folders unchanged into <config>/plugins/<id>/.
    const homeDir = join(root, 'home');
    const home = Home.sandbox(homeDir);
    await mkdir(home.plugins, { recursive: true });
    for (const id of runnerIds) {
      const targetDir = join(home.plugins, id);
      await cp(join(installedRunnersDir, id), targetDir, { recursive: true });
      assertNoNodeModulesAncestor(targetDir);
    }
    assertNoNodeModulesAncestor(home.plugins);

    const copyPluginsRes = await runWrapped(packageRoot, homeDir, root, ['plugins', '--json']);
    assert.equal(copyPluginsRes.code, 0, copyPluginsRes.stderr);
    const copyPlugins = JSON.parse(copyPluginsRes.stdout) as PluginsJson;
    assert.deepEqual(copyPlugins.loaded.filter(p => p.source === 'bundled'), []);
    assert.deepEqual(copyPlugins.failed.filter(p => p.source === 'bundled'), []);

    const fixtureRepo = join(root, 'fixture-repo');
    await initFixtureRepo(fixtureRepo, runnerIds);
    const dataDir = projectPaths(fixtureRepo).write;

    for (const id of runnerIds) {
      const beforeIds = new Set(readPersistedRuns(dataDir).map(run => String(run.id)));
      const result = await runWrapped(
        packageRoot,
        homeDir,
        fixtureRepo,
        ['run', 'mock:cezar-done', '--workflow', `copy-out-${id}`, '--repo', fixtureRepo],
        { HSQ_DRY_RUN: '1' },
      );
      const created = readPersistedRuns(dataDir).find(run => !beforeIds.has(String(run.id)));
      const stepBackend = Array.isArray(created?.steps) ? (created.steps.at(-1) as { backend?: unknown } | undefined)?.backend : undefined;
      const ok = result.code === 0
        && created !== undefined
        && stepBackend === id
        && (created.status === RUN_STATUS.done || created.status === RUN_STATUS.review);
      assertCopyOutOutcome(
        id,
        { ok, detail: `exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}` },
        hasRunnerFolderEscapeBaselineEntries(id, repoRoot),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
