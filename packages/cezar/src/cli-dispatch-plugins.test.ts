import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testHome } from './home/test-home.testkit.ts';
import type { CliDeps } from './cli-dispatch.ts';
import { BUILT_IN_RUNNER_IDS } from './core/built-in-runner-ids.testkit.ts';
import { bundledRunnersDir } from './plugin/bundled-runners.ts';

// Real dispatch from an unsealed process, as `hsq` starts: the command line picks the boot.
const home = testHome();

beforeEach(() => {
  vi.resetModules();
  (globalThis as { pluginCalls?: unknown[] }).pluginCalls = [];
});
afterEach(() => {
  rmSync(home.plugins, { recursive: true, force: true });
  delete (globalThis as { pluginCalls?: unknown[] }).pluginCalls;
  vi.restoreAllMocks();
});

function writePlugin(name: string, source: string): void {
  mkdirSync(join(home.plugins, name), { recursive: true });
  writeFileSync(join(home.plugins, name, 'index.mjs'), source);
}

const greeter = `export default function setup(api) {
  api.registerCliCommand({
    name: 'greet', usage: ['  hsq greet <name>   say hello'], parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'always',
    load: async () => async argv => { globalThis.pluginCalls.push(argv); return 7; },
  });
}
`;

async function dispatch(args: string[]) {
  const { defaultCliDeps, main } = await import('./cli-dispatch.ts');
  const processStub = { argv: ['/bin/node', '/bin/hsq', ...args], env: {}, cwd: vi.fn(() => '/work'), exitCode: undefined as number | undefined };
  const deps = {
    ...defaultCliDeps,
    process: processStub,
    console: { log: vi.fn(), error: vi.fn() },
    resolveCliHome: vi.fn(() => home),
    prepareOperatorHome: vi.fn(() => home),
    getRepoInfo: vi.fn().mockResolvedValue(null),
    readOwnVersion: vi.fn(() => '1.2.3'),
    serveCommand: vi.fn(), serverCommand: vi.fn(), runCommand: vi.fn(), initCommand: vi.fn(),
  };
  await main(deps as unknown as CliDeps);
  const registries = {
    cli: (await import('./core/cli-registry.ts')).cliCommandsSealed(),
    runners: (await import('./core/runner-registry.ts')).runnersSealed(),
  };
  return { deps, processStub, registries };
}

describe('plugin commands at dispatch', () => {
  it('boots fully for an unknown name and dispatches the command a host plugin registered', async () => {
    writePlugin('greeter', greeter);
    const { processStub, registries, deps } = await dispatch(['greet', 'Ada', '--loud']);
    expect((globalThis as { pluginCalls?: unknown[] }).pluginCalls).toEqual([['Ada', '--loud']]);
    expect(processStub.exitCode).toBe(7);
    expect(registries).toEqual({ cli: true, runners: true });
    expect(deps.console.error).not.toHaveBeenCalled();
  });

  it('boots fully, then refuses a name no built-in or plugin registered', async () => {
    writePlugin('greeter', greeter);
    const { processStub, registries, deps } = await dispatch(['nope']);
    expect(deps.console.error).toHaveBeenCalledWith('unknown command: nope\n');
    expect(deps.console.log.mock.calls[0]![0]).toContain('hsq greet <name>');
    expect(processStub.exitCode).toBe(1);
    expect(registries).toEqual({ cli: true, runners: true });
  });

  it('skips a broken plugin with a stderr warning and still dispatches the others', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    writePlugin('a-broken', "export default function setup(api) { api.registerCliCommand({ name: 'leak', usage: [], parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none', load: async () => async () => 0 }); throw new Error('boom'); }\n");
    writePlugin('greeter', greeter);
    const { processStub } = await dispatch(['greet']);
    expect(processStub.exitCode).toBe(7);
    expect(stderr).toHaveBeenCalledWith('[hsq] plugin "a-broken" skipped: boom\n');
    expect((await import('./core/cli-registry.ts')).hasCliCommand('leak')).toBe(false);
  });

  it('lists loaded and skipped plugins with hsq plugins', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    writePlugin('greeter', greeter);
    mkdirSync(join(home.plugins, 'empty'), { recursive: true });
    const { processStub } = await dispatch(['plugins', '--json']);
    expect(processStub.exitCode).toBe(0);
    const report = JSON.parse(log.mock.calls[0]![0] as string);
    // The bundled runners load first, through the same loader, then the host folder.
    expect(report.folders).toEqual([bundledRunnersDir(), home.plugins]);
    expect(report.loaded).toEqual([
      ...BUILT_IN_RUNNER_IDS.map(id => expect.objectContaining({ name: id, source: 'bundled', contributions: expect.objectContaining({ runners: [id] }) })),
      expect.objectContaining({ name: 'greeter', source: 'host', contributions: expect.objectContaining({ cliCommands: ['greet'] }) }),
    ]);
    expect(report.failed).toEqual([expect.objectContaining({ name: 'empty', error: 'missing index.mjs or index.js' })]);
  });

  it('loads the same host plugin folder when a command wrapper boots before dispatch', async () => {
    writePlugin('greeter', greeter);
    const { prepareCommandRuntime } = await import('./subcommands.ts');
    await prepareCommandRuntime('serve');
    expect((await import('./core/cli-registry.ts')).cliCommand('greet')?.name).toBe('greet');
    expect((await import('./plugin/loader.ts')).pluginLoadReport().folders).toEqual([bundledRunnersDir(), home.plugins]);
  });

  it('keeps help cold: no Home, no plugin, no runner, and a footer that points to hsq plugins', async () => {
    writePlugin('greeter', greeter);
    const { deps, registries } = await dispatch(['--help']);
    expect(deps.resolveCliHome).not.toHaveBeenCalled();
    expect(registries).toEqual({ cli: true, runners: false });
    const help = deps.console.log.mock.calls[0]![0] as string;
    expect(help).toContain('run `hsq plugins` to list them');
    expect(help).not.toContain('greet');
    expect((await import('./plugin/loader.ts')).pluginLoadReport().folders).toEqual([]);
  });
});
