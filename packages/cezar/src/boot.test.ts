import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { BUILT_IN_RUNNER_IDS } from './core/built-in-runner-ids.testkit.ts';
import { bundledRunnersDir } from './plugin/bundled-runners.ts';

const srcRoot = fileURLToPath(new URL('.', import.meta.url));

/** Registry definition modules may call seal. Production boot may not, except boot.ts. */
const SEAL_ALLOWLIST = new Set([
  'boot.ts',
  'built-in-run-slots.ts',
  'core/cli-registry.ts',
  'core/runner-registry.ts',
  'runs/lifecycle-registry.ts',
  'runs/removal-slots.ts',
  'runs/worker-executions-registry.ts',
  'workflows/step-kind-registry.ts',
  'ci-wait/tool-registry.ts',
  'workflows/run/wait-kind-registry.ts',
]);

function productionSources(dir = ''): string[] {
  return readdirSync(join(srcRoot, dir), { withFileTypes: true }).flatMap(entry => {
    const relative = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return productionSources(relative);
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.testkit.ts')) return [];
    return [relative];
  });
}

it('seals all eight registries and runs beforeSeal only on the first full boot', async () => {
  vi.resetModules();
  const boot = await import('./boot.ts');
  const order: string[] = [];
  const cli = await import('./core/cli-registry.ts');
  const runners = await import('./core/runner-registry.ts');
  const slots = await import('./runs/removal-slots.ts');
  const workers = await import('./runs/worker-executions-registry.ts');
  const steps = await import('./workflows/step-kind-registry.ts');
  const tools = await import('./ci-wait/tool-registry.ts');
  const waits = await import('./workflows/run/wait-kind-registry.ts');
  const lifecycle = await import('./runs/lifecycle-registry.ts');
  const sealed = () => ({
    cli: cli.cliCommandsSealed(), runners: runners.runnersSealed(), slots: slots.runSlotsSealed(),
    workers: workers.workerExecutionsSealed(), steps: steps.stepKindsSealed(),
    tools: tools.agentToolsSealed(), waits: waits.waitKindsSealed(),
    lifecycle: lifecycle.runLifecycleListenersSealed(),
  });
  expect(Object.values(sealed()).some(Boolean)).toBe(false);
  await boot.bootRuntime({ beforeSeal: () => {
    order.push('hook');
    const state = sealed();
    expect(Object.values(state).every(value => value === false), JSON.stringify(state)).toBe(true);
  } });
  expect(order).toEqual(['hook']);
  expect(sealed()).toEqual({
    cli: true, runners: true, slots: true, workers: true, steps: true, tools: true, waits: true, lifecycle: true,
  });
  await boot.bootRuntime({ beforeSeal: () => { order.push('again'); } });
  expect(order).toEqual(['hook']);
});

it('seals only the CLI command table on a cold boot', async () => {
  vi.resetModules();
  const boot = await import('./boot.ts');
  const cli = await import('./core/cli-registry.ts');
  boot.bootColdCli();
  expect(cli.cliCommandsSealed()).toBe(true);
  expect(cli.knownCliCommand('job')?.name).toBe('job');
  const runners = await import('./core/runner-registry.ts');
  const slots = await import('./runs/removal-slots.ts');
  const workers = await import('./runs/worker-executions-registry.ts');
  const steps = await import('./workflows/step-kind-registry.ts');
  const tools = await import('./ci-wait/tool-registry.ts');
  const waits = await import('./workflows/run/wait-kind-registry.ts');
  const lifecycle = await import('./runs/lifecycle-registry.ts');
  expect([
    runners.runnersSealed(), slots.runSlotsSealed(), workers.workerExecutionsSealed(),
    steps.stepKindsSealed(), tools.agentToolsSealed(), waits.waitKindsSealed(),
    lifecycle.runLifecycleListenersSealed(),
  ]).toEqual([false, false, false, false, false, false, false]);
  boot.bootColdCli();
  expect(runners.runnersSealed()).toBe(false);
});

it('keeps every registry unsealed when the hook rejects, then boots on retry', async () => {
  vi.resetModules();
  const boot = await import('./boot.ts');
  const runners = await import('./core/runner-registry.ts');
  await expect(boot.bootRuntime({ beforeSeal: () => { throw new Error('hook failed'); } })).rejects.toThrow('hook failed');
  expect(runners.runnersSealed()).toBe(false);
  await boot.bootRuntime();
  expect(runners.runnersSealed()).toBe(true);
});

it('boots the other registries after the CLI command table is already sealed', async () => {
  vi.resetModules();
  const { registerCliCommand, sealCliCommands } = await import('./core/cli-registry.ts');
  const command = { name: 'fixture', usage: ['  hsq fixture'], parseMode: 'subcommand',
    homeMode: 'none', runtimeMode: 'none', load: async () => async () => 0 } as const;
  registerCliCommand(command);
  sealCliCommands();
  const boot = await import('./boot.ts');
  await boot.bootRuntime();
  const { cliCommand } = await import('./core/cli-registry.ts');
  const { runnersSealed } = await import('./core/runner-registry.ts');
  expect(cliCommand('fixture')).toBe(command);
  expect(runnersSealed()).toBe(true);
});

afterEach(() => { vi.doUnmock('./plugin/resolve-hook.ts'); vi.doUnmock('./plugin/loader.ts'); });

/** A host plugin folder with one plugin that registers a CLI command and a run lifecycle listener. */
function pluginsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hsq-boot-plugins-'));
  mkdirSync(join(dir, 'extra'));
  writeFileSync(join(dir, 'extra', 'index.mjs'), `export default function setup(api) {
  api.registerCliCommand({ name: 'extra', usage: [], parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none', load: async () => async () => 0 });
  api.onRunLifecycle({});
}
`);
  return dir;
}

/** The ids of the bundled runners the loader reported, in load order. */
async function bundledNames(): Promise<string[]> {
  return (await import('./plugin/loader.ts')).pluginLoadReport().loaded.filter(plugin => plugin.source === 'bundled').map(plugin => plugin.name);
}

it('installs the resolve hook, loads the bundled runners, then host plugins, then seals', async () => {
  vi.resetModules();
  const order: string[] = [];
  vi.doMock('./plugin/resolve-hook.ts', () => ({ installPluginResolveHook: () => { order.push('hook'); } }));
  vi.doMock('./plugin/loader.ts', async (original) => {
    const loader = await original<typeof import('./plugin/loader.ts')>();
    return {
      ...loader,
      loadBundledRunners: async (...args: Parameters<typeof loader.loadBundledRunners>) => { order.push('runners'); return loader.loadBundledRunners(...args); },
      loadPluginFolder: async (...args: Parameters<typeof loader.loadPluginFolder>) => { order.push('plugins'); return loader.loadPluginFolder(...args); },
    };
  });
  const dir = pluginsDir();
  try {
    const boot = await import('./boot.ts');
    const cli = await import('./core/cli-registry.ts');
    const lifecycle = await import('./runs/lifecycle-registry.ts');
    await boot.bootRuntime({ pluginsDir: dir, beforeSeal: () => {
      order.push('beforeSeal');
      // The plugin committed before the hook runs and before any seal.
      expect(cli.cliCommandsSealed()).toBe(false);
    } });
    // The loader asks for the hook again before the first plugin of each folder; the real install is idempotent.
    expect(order).toEqual(['hook', 'runners', 'hook', 'plugins', 'hook', 'beforeSeal']);
    expect(cli.cliCommand('extra')?.name).toBe('extra');
    expect(lifecycle.registeredRunLifecycleListeners()).toHaveLength(1);
    const report = (await import('./plugin/loader.ts')).pluginLoadReport();
    expect(report.folders).toEqual([bundledRunnersDir(), dir]);
    expect(report.loaded.map(plugin => [plugin.name, plugin.source])).toEqual([...BUILT_IN_RUNNER_IDS.map(id => [id, 'bundled']), ['extra', 'host']]);
    expect(report.failed).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('loads no host plugin without a plugin folder and never installs the hook on a cold boot', async () => {
  vi.resetModules();
  const install = vi.fn();
  vi.doMock('./plugin/resolve-hook.ts', () => ({ installPluginResolveHook: install }));
  const boot = await import('./boot.ts');
  boot.bootColdCli();
  expect(install).not.toHaveBeenCalled();
  await boot.bootRuntime();
  // Once by boot and once by the bundled runner load.
  expect(install).toHaveBeenCalledTimes(2);
  expect((await import('./plugin/loader.ts')).pluginLoadReport().folders).toEqual([bundledRunnersDir()]);
  expect(await bundledNames()).toEqual([...BUILT_IN_RUNNER_IDS]);
  expect((await import('./core/runner-registry.ts')).registeredRunners().map(runner => runner.id)).toEqual([...BUILT_IN_RUNNER_IDS]);
});

it('does not load host plugins twice when a failed hook is retried', async () => {
  vi.resetModules();
  const dir = pluginsDir();
  try {
    const boot = await import('./boot.ts');
    await expect(boot.bootRuntime({ pluginsDir: dir, beforeSeal: () => { throw new Error('hook failed'); } })).rejects.toThrow('hook failed');
    await boot.bootRuntime({ pluginsDir: dir });
    const report = (await import('./plugin/loader.ts')).pluginLoadReport();
    expect(report.folders).toEqual([bundledRunnersDir(), dir]);
    expect(report.loaded.map(plugin => plugin.name)).toEqual([...BUILT_IN_RUNNER_IDS, 'extra']);
    expect(report.failed).toEqual([]);
    expect((await import('./core/cli-registry.ts')).cliCommand('extra')?.name).toBe('extra');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('seals registries from boot.ts and the registry definitions only', () => {
  const sealCall = /\bseal[A-Z][A-Za-z]*\(/;
  const sealFunction = /^\s*(?:export\s+)?(?:async\s+)?function\s+seal[A-Z]/m;
  const offenders = productionSources().filter(file => !SEAL_ALLOWLIST.has(file)).filter(file => {
    const source = readFileSync(join(srcRoot, file), 'utf8');
    return sealFunction.test(source) || sealCall.test(source);
  });
  expect(offenders).toEqual([]);
});

it('fails boot, and every retry, when a bundled runner fails to load', async () => {
  vi.resetModules();
  const failure = new Error('Bundled runner "claude" failed to load: broken');
  const load = vi.fn(async () => { throw failure; });
  vi.doMock('./plugin/loader.ts', async (original) => ({ ...await original<typeof import('./plugin/loader.ts')>(), loadBundledRunners: load }));
  const boot = await import('./boot.ts');
  await expect(boot.bootRuntime()).rejects.toBe(failure);
  await expect(boot.bootRuntime()).rejects.toBe(failure);
  expect(load).toHaveBeenCalledOnce();
  expect((await import('./core/runner-registry.ts')).runnersSealed()).toBe(false);
});

it('boots with no bundled runner when bundledRunnersDir is empty and reuses that boot on later calls', async () => {
  vi.resetModules();
  const emptyBundled = mkdtempSync(join(tmpdir(), 'hsq-empty-bundled-'));
  const hostDir = mkdtempSync(join(tmpdir(), 'hsq-host-runner-'));
  mkdirSync(join(hostDir, 'claude'));
  writeFileSync(join(hostDir, 'claude', 'index.mjs'), `export default function setup(api) {
  api.registerRunner({ id: 'claude', display: { displayName: 'Host Claude' } });
}
`);
  const loadBundled = vi.fn();
  const loadFolder = vi.fn();
  vi.doMock('./plugin/loader.ts', async (original) => {
    const loader = await original<typeof import('./plugin/loader.ts')>();
    return {
      ...loader,
      loadBundledRunners: (...args: Parameters<typeof loader.loadBundledRunners>) => { loadBundled(...args); return loader.loadBundledRunners(...args); },
      loadPluginFolder: (...args: Parameters<typeof loader.loadPluginFolder>) => { loadFolder(...args); return loader.loadPluginFolder(...args); },
    };
  });
  try {
    const boot = await import('./boot.ts');
    const first = boot.bootRuntime({ bundledRunnersDir: emptyBundled, pluginsDir: hostDir });
    const second = boot.bootRuntime({ pluginsDir: hostDir });
    expect(second).toBe(first);
    await first;
    await boot.bootRuntime();
    expect(loadBundled).toHaveBeenCalledExactlyOnceWith(emptyBundled, { allowEmpty: true });
    expect(loadFolder).toHaveBeenCalledTimes(1);
    const runners = await import('./core/runner-registry.ts');
    expect(runners.registeredRunners().map(runner => [runner.id, runner.display.displayName])).toEqual([['claude', 'Host Claude']]);
    const report = (await import('./plugin/loader.ts')).pluginLoadReport();
    expect(report.folders).toEqual([emptyBundled, hostDir]);
    expect(report.loaded.map(plugin => [plugin.name, plugin.source])).toEqual([['claude', 'host']]);
    expect(report.failed).toEqual([]);
  } finally {
    rmSync(emptyBundled, { recursive: true, force: true });
    rmSync(hostDir, { recursive: true, force: true });
  }
});
