import { execFile, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { healthResponseSchema } from '@open-mercato/cezar-contract/health';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { Home } from '../home/home.ts';
import { projectPaths } from '../project-paths.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';

/**
 * An external runner plugin, end to end (spec 2026-11-24-plugin-loader-and-runner-kit, slice D2).
 * The plugin is plain JS in a folder outside the repository, `<config>/plugins/ext-runner/`, and
 * imports Squawk only through `@hearsay-tools/squawk/plugin` and its `/runtime` subpath. Each `hsq`
 * call is a new process on the real CLI entry, so each one is a restart: the runner loads, a task
 * runs on it to the review gate, the plugin breaks and the settings that name its runner survive,
 * and once the plugin is back those settings act again.
 */

const pkg = fileURLToPath(new URL('../..', import.meta.url));
const cli = fileURLToPath(new URL('../index.ts', import.meta.url));
const fixture = fileURLToPath(new URL('./__fixtures__/external-runner', import.meta.url));
const RUNNER = 'ext-runner';
const BROKEN_SETUP = "export default function setup(api) {\n  throw new Error('ext-runner: its native dependency is missing');\n}\n";

/**
 * Break the plugin: its `index.mjs` is gone and an `index.js` whose setup throws takes its place.
 * A new entry file, not new content in the old one: Node caches an imported file by URL for the
 * life of the process, and the in-process boots below share the test's process.
 */
function breakPlugin(): void {
  rmSync(join(plugin, 'index.mjs'));
  writeFileSync(join(plugin, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(plugin, 'index.js'), BROKEN_SETUP);
}

function restorePlugin(): void {
  rmSync(join(plugin, 'index.js'), { force: true });
  rmSync(join(plugin, 'package.json'), { force: true });
  cpSync(join(fixture, 'index.mjs'), join(plugin, 'index.mjs'));
}

// bound: a hang guard for one `hsq` process (a cold tsx start, then at most one short task); the
// process exit is the signal.
const CLI_TIMEOUT_MS = 60_000;

let root: string;
/** The folder `HSQ_HOME` names; `Home.sandbox` lays the config, state and data roots out under it. */
let homeDir: string;
let home: Home;
let repo: string;
let plugin: string;

interface CliResult { code: number; stdout: string; stderr: string }

/** One `hsq` process on the sandbox home. The task env of the test runner does not leak into it. */
async function hsq(...args: string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, HSQ_HOME: homeDir, CEZ_HOME: homeDir };
  for (const key of Object.keys(env)) {
    if (/^(?:CEZ|HSQ)_(?:TOOL_|TASK_|DELEGATION|HANDOFF_|ARTIFACTS_|PROJECT_|COCKPIT_|DRY_RUN|AGENT_MODELS_LOCKED|REVIEW_GATE|REMOTE)/.test(key) || key.startsWith('EXT_AGENT_')) delete env[key];
  }
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', 'tsx', cli, ...args], { cwd: pkg, env, timeout: CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : -1;
      resolve({ code, stdout, stderr });
    });
  });
}

interface PluginsJson {
  loaded: { name: string; source: string; path: string; contributions: { runners: string[] } }[];
  failed: { name: string; source: string; path: string; reason: string; error: string }[];
}

async function plugins(): Promise<{ report: PluginsJson; stderr: string }> {
  const result = await hsq('plugins', '--json');
  expect(result.code, result.stderr).toBe(0);
  return { report: JSON.parse(result.stdout) as PluginsJson, stderr: result.stderr };
}

/** A fresh module graph that boots like `hsq` does, with the sandbox `<config>/plugins/`. */
async function bootInProcess() {
  vi.resetModules();
  const { bootRuntime } = await import('../boot.ts');
  const warnings: string[] = [];
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { warnings.push(String(chunk)); return true; });
  try {
    await bootRuntime({ pluginsDir: home.plugins });
  } finally {
    write.mockRestore();
  }
  return {
    warnings,
    registry: await import('../core/runner-registry.ts'),
    workspace: await import('../workspace/config.ts'),
    accounts: await import('../workspace/agent-accounts.ts'),
    profiles: await import('../workspace/agent-profiles.ts'),
    config: await import('../config.ts'),
  };
}

/** `GET /api/v1/health` of a local cockpit, which names each plugin's folder. */
async function health() {
  vi.stubEnv('HSQ_REMOTE', '');
  vi.stubEnv('CEZ_REMOTE', '');
  const { RunStore } = await import('../runs/store.ts');
  const { createApp } = await import('../server/server.ts');
  const { apiRequest } = await import('../server/loopback-request.testkit.ts');
  const store = RunStore.open(join(root, 'health-store'));
  try {
    const app = createApp({ home, repoRoot: repo, store, manager: {} as never, version: '0.0.0-test' });
    const res = await apiRequest(app, '/api/v1/health');
    expect(res.status).toBe(200);
    return healthResponseSchema.parse(await res.json());
  } finally {
    store.persistence.flush();
    store.close();
    vi.unstubAllEnvs();
  }
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const repoConfigPath = () => join(repo, '.ai/squawk/config.json');

/** The stored settings that name the plugin's runner, as the files hold them. */
function storedSettings() {
  const workspace = readJson(home.workspaceConfig);
  const accounts = readJson(home.agentAccounts);
  return {
    agentDefaults: workspace.agentDefaults,
    disabledProviders: workspace.disabledProviders,
    accounts: accounts.accounts,
    selections: accounts.selections,
    repo: readJson(repoConfigPath()),
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** The task's last run, read from the repo's run store after the `hsq run` process ended. */
function lastRun() {
  const runs = readPersistedRuns(projectPaths(repo).write);
  return runs.at(-1)!;
}

// bound: a hang guard for each case, which starts up to three `hsq` processes in a row.
describe('an external plain-JS runner plugin in <config>/plugins/', { timeout: 240_000 }, () => {
  let account: string;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'hsq-external-runner-')));
    homeDir = join(root, 'home');
    home = Home.sandbox(homeDir);
    plugin = join(home.plugins, RUNNER);
    // The plugin folder is a copy outside the repository: nothing resolves a repository path from it.
    mkdirSync(home.plugins, { recursive: true });
    cpSync(fixture, plugin, { recursive: true });
    expect(relative(fileURLToPath(new URL('../../../..', import.meta.url)), plugin).startsWith('..')).toBe(true);
    // Every specifier in the plugin: static and re-export `from`, bare `import '...'` and `import(...)`.
    const specifiers = ['index.mjs', 'adapter.mjs', 'agent.mjs'].flatMap(file =>
      [...readFileSync(join(plugin, file), 'utf8').matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)(['"`])([^'"`]+)\1/g)].map(match => match[2]!));
    expect(specifiers).toEqual(expect.arrayContaining(['@hearsay-tools/squawk/plugin', '@hearsay-tools/squawk/plugin/runtime', './adapter.mjs']));
    expect(specifiers.filter(specifier => !specifier.startsWith('node:') && !specifier.startsWith('./') && !/^@hearsay-tools\/squawk\/plugin(?:\/runtime)?$/.test(specifier))).toEqual([]);

    repo = join(root, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'init');
    mkdirSync(join(repo, '.ai/squawk'), { recursive: true });
    writeFileSync(repoConfigPath(), `${JSON.stringify({ reviewGate: true, defaultRunner: RUNNER, defaultModels: { [RUNNER]: 'ext-repo-model' } })}\n`);

    // Every stored setting that names the runner, written before the first process starts.
    account = join(root, 'ext-account');
    mkdirSync(account);
    Home.seed(home, home.workspaceConfig, {
      schemaVersion: 1,
      disabledProviders: ['codex'],
      agentDefaults: { runner: RUNNER, models: { [RUNNER]: 'ext-machine-model', claude: 'sonnet' } },
      projects: [],
    });
    Home.seed(home, home.agentAccounts, {
      version: 1,
      accounts: [{ id: 'ext-work', provider: RUNNER, configDir: account, label: 'Ext work', addedAt: '' }],
      selections: { [repo]: { [RUNNER]: 'ext-work' } },
    });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('loads from <config>/plugins/ and runs a task on its runner to the review gate', async () => {
    const { report, stderr } = await plugins();
    expect(report.failed).toEqual([]);
    expect(report.loaded.filter(entry => entry.source === 'host')).toEqual([
      expect.objectContaining({ name: RUNNER, path: plugin, contributions: expect.objectContaining({ runners: [RUNNER] }) }),
    ]);
    expect(stderr).not.toContain('skipped');

    const result = await hsq('run', 'write the external runner note', '--repo', repo);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    // The repo's defaultRunner picked the plugin's runner, and the project's account selection
    // reached its CLI.
    expect(result.stdout).toContain(`runner: ${RUNNER}`);
    expect(result.stdout).toContain(`external runner reply: account=${account}`);
    expect(result.stdout).toContain('→ cezar_done');
    expect(result.stdout).toContain('run review');

    const run = lastRun();
    expect(run).toMatchObject({ status: RUN_STATUS.review, runner: RUNNER });
    expect(run.steps.at(-1)).toMatchObject({ backend: RUNNER });
    expect(readFileSync(join(run.worktreePath!, 'EXTERNAL_RUNNER.md'), 'utf8')).toContain('write the external runner note');
  });

  it('keeps every stored setting through a restart where the plugin fails to load', async () => {
    // A disabled flag for the runner, stored by a process that has it registered. Stored settings
    // are read after boot, so every in-process read and write here runs in a booted module graph.
    const registered = await bootInProcess();
    expect(registered.registry.isRegisteredRunner(RUNNER)).toBe(true);
    await registered.workspace.mergeWriteWorkspaceConfig(config => { config.disabledProviders = ['codex', RUNNER]; }, home);
    const before = storedSettings();
    expect(before).toMatchObject({ agentDefaults: { runner: RUNNER }, disabledProviders: ['codex', RUNNER] });

    breakPlugin();
    const { report, stderr } = await plugins();
    expect(report.loaded.map(entry => entry.name)).not.toContain(RUNNER);
    expect(report.failed).toEqual([{ name: RUNNER, source: 'host', path: plugin, reason: 'setup', error: 'ext-runner: its native dependency is missing' }]);
    expect(stderr).toContain(`[hsq] plugin "${RUNNER}" skipped: ext-runner: its native dependency is missing`);

    // An unrelated workspace write in a process that skipped the plugin.
    const other = join(root, 'other-project');
    mkdirSync(other);
    const added = await hsq('projects', 'add', other);
    expect(added.code, added.stderr).toBe(0);

    const booted = await bootInProcess();
    expect(booted.warnings.join('')).toContain(`[hsq] plugin "${RUNNER}" skipped`);
    expect((await health()).plugins.failed).toEqual([{
      name: RUNNER, source: 'host', path: plugin,
      error: 'setup failed or a registration was refused; run `hsq plugins` on the host for the error',
    }]);
    expect(booted.registry.isRegisteredRunner(RUNNER)).toBe(false);
    // Reads keep the ids; execution falls back to the default runner without rewriting them.
    const config = await booted.workspace.loadWorkspaceConfig(home.workspaceConfig);
    expect(config.agentDefaults).toMatchObject({ runner: RUNNER, models: { [RUNNER]: 'ext-machine-model' } });
    expect(config.disabledProviders).toEqual(expect.arrayContaining(['codex', RUNNER]));
    expect(booted.registry.resolveRunnerId(config.agentDefaults.runner)).toBe('claude');
    const repoConfig = await booted.config.loadConfig(repo, home);
    expect(repoConfig).toMatchObject({ defaultRunner: RUNNER, defaultModels: { [RUNNER]: 'ext-repo-model' } });
    expect((await booted.accounts.loadAgentAccounts(home)).accounts.map(row => row.id)).toEqual(['ext-work']);

    // Unrelated writes to each store while the runner is unregistered.
    await booted.workspace.mergeWriteWorkspaceConfig(next => { next.resources.maxParallel = 3; }, home);
    await booted.accounts.mergeWriteAgentAccounts(store => { store.selections[other] = { claude: 'default' }; }, home);
    const { writeMergedConfig } = await import('../server/config-merge.ts');
    expect(await writeMergedConfig(projectPaths(repo).write, { worktreeRetention: 4 })).toBeUndefined();

    const after = storedSettings();
    expect(after.agentDefaults).toEqual(before.agentDefaults);
    expect(after.disabledProviders).toEqual(before.disabledProviders);
    expect(after.accounts).toEqual(before.accounts);
    expect(after.selections).toMatchObject(before.selections as object);
    expect(after.repo).toEqual({ ...before.repo, worktreeRetention: 4 });
    expect(readJson(home.workspaceConfig)).toMatchObject({ resources: { maxParallel: 3 } });
    expect((readJson(home.workspaceConfig).projects as { root: string }[]).map(project => project.root)).toContain(other);
  });

  it('acts on the stored settings again once the plugin is restored', async () => {
    restorePlugin();
    const { report } = await plugins();
    const registered = await bootInProcess();
    // The disabled flag the previous case stored; set here too, so this case also runs alone.
    await registered.workspace.mergeWriteWorkspaceConfig(next => { next.disabledProviders = ['codex', RUNNER]; }, home);
    expect(report.failed).toEqual([]);
    expect(report.loaded.map(entry => entry.name)).toContain(RUNNER);

    const booted = registered;
    expect(booted.warnings.join('')).toBe('');
    expect((await health()).plugins).toMatchObject({ failed: [], loaded: expect.arrayContaining([{ name: RUNNER, source: 'host', path: plugin }]) });
    const config = await booted.workspace.loadWorkspaceConfig(home.workspaceConfig);
    expect(booted.registry.resolveRunnerId(config.agentDefaults.runner)).toBe(RUNNER);
    expect(config.agentDefaults.models).toMatchObject({ [RUNNER]: 'ext-machine-model' });
    expect((await booted.config.loadConfig(repo, home)).defaultModels).toMatchObject({ [RUNNER]: 'ext-repo-model' });
    expect(booted.profiles.selectProfile(await booted.accounts.loadAgentAccounts(home), { provider: RUNNER, repoRoot: repo })).toMatchObject({ id: 'ext-work', isDefault: false });

    // The stored disabled flag refuses the start...
    const refused = await hsq('run', 'must not start', '--repo', repo);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('External Runner is disabled');
    const runs = readPersistedRuns(projectPaths(repo).write).length;

    // ...and once enabled, the repo default runs the task on the plugin's runner, on the selected account.
    await booted.workspace.mergeWriteWorkspaceConfig(next => { next.disabledProviders = ['codex']; }, home);
    const result = await hsq('run', 'write the note again', '--repo', repo);
    expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`external runner reply: account=${account}`);
    expect(readPersistedRuns(projectPaths(repo).write)).toHaveLength(runs + 1);
    expect(lastRun()).toMatchObject({ status: RUN_STATUS.review, runner: RUNNER });
    expect(existsSync(join(lastRun().worktreePath!, 'EXTERNAL_RUNNER.md'))).toBe(true);
  });
});
