import { expect, it, vi } from 'vitest';

it('enforces register then seal, conflicts, and reference idempotency', async () => {
  vi.resetModules();
  const registry = await import('./cli-registry.ts');
  const command = { name: 'fixture', usage: ['  hsq fixture'], parseMode: 'subcommand',
    homeMode: 'none', runtimeMode: 'none', load: async () => async () => 7 } as const;
  expect(() => registry.cliCommand('fixture')).toThrow(/CLI commands is unsealed/);
  expect(() => registry.registeredCliCommands()).toThrow(/unsealed/);
  expect(() => registry.hasCliCommand('fixture')).toThrow(/unsealed/);
  expect(registry.knownCliCommand('fixture')).toBeUndefined();
  registry.registerCliCommand(command);
  registry.registerCliCommand(command);
  expect(() => registry.registerCliCommand({ ...command })).toThrow(/conflicting/);
  registry.sealCliCommands();
  registry.sealCliCommands();
  registry.registerCliCommand(command);
  expect(registry.cliCommandsSealed()).toBe(true);
  expect(registry.hasCliCommand('fixture')).toBe(true);
  expect(registry.cliCommand('fixture')).toBe(command);
  expect(registry.registeredCliCommands()).toEqual([command]);
  expect(() => registry.registerCliCommand({ ...command, name: 'late' })).toThrow(/sealed/);
});

it('renders and dispatches a custom command without core edits', async () => {
  vi.resetModules();
  const { registerCliCommand, sealCliCommands } = await import('./cli-registry.ts');
  const { registerBuiltInCliCommands } = await import('../built-in-cli-commands.ts');
  registerBuiltInCliCommands();
  const handler = vi.fn(async () => 7);
  const load = vi.fn(async () => handler);
  registerCliCommand({ name: 'fixture', usage: ['  cez fixture             custom fixture command'],
    parseMode: 'subcommand', homeMode: 'none', runtimeMode: 'none', load });
  sealCliCommands();
  const { main, defaultCliDeps } = await import('../cli-dispatch.ts');
  const log = vi.fn();
  const deps = { ...defaultCliDeps, console: { log, error: vi.fn() },
    process: { argv: ['/bin/node', '/bin/hsq', '--help'], env: {}, exitCode: undefined },
    resolveCliHome: () => { throw new Error('Unexpected Home access'); }, readOwnVersion: () => '0',
  } as unknown as import('../cli-dispatch.ts').CliDeps;
  await main(deps);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('hsq fixture             custom fixture command'));
  expect(load).not.toHaveBeenCalled();
  deps.process.argv = ['/bin/node', '/bin/hsq', 'fixture', '--custom-flag'];
  await main(deps);
  expect(handler).toHaveBeenCalledWith(['--custom-flag'], deps.process.env);
  expect(deps.process.exitCode).toBe(7);
  const { knownRunnerIds } = await import('./runner-registry.ts');
  expect(knownRunnerIds()).toEqual([]);
});

it('passes root arguments to runtime predicates before loading the command', async () => {
  vi.resetModules();
  const { registerCliCommand, sealCliCommands } = await import('./cli-registry.ts');
  const { registeredRunners } = await import('./runner-registry.ts');
  const { runSlotsSealed } = await import('../runs/removal-slots.ts');
  const predicate = vi.fn((argv: readonly string[]) => argv.includes('warm'));
  const handler = vi.fn(async () => {
    expect(registeredRunners().length).toBeGreaterThan(0);
    expect(runSlotsSealed()).toBe(true);
  });
  registerCliCommand({ name: 'fixture-root', usage: ['  cez fixture-root'],
    parseMode: 'root', homeMode: 'none', runtimeMode: predicate, load: async () => handler });
  sealCliCommands();
  const { main, defaultCliDeps } = await import('../cli-dispatch.ts');
  await main({ ...defaultCliDeps,
    process: { argv: ['/bin/node', '/bin/hsq', 'fixture-root', 'warm'], env: {}, cwd: () => '/work' },
    getRepoInfo: async () => null,
    resolveCliHome: () => { throw new Error('Unexpected Home access'); }, readOwnVersion: () => '0',
  } as unknown as import('../cli-dispatch.ts').CliDeps);
  expect(predicate).toHaveBeenCalledWith(['warm']);
  expect(handler).toHaveBeenCalledOnce();
});
