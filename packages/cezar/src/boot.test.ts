import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';

const srcRoot = fileURLToPath(new URL('.', import.meta.url));

/** Registry definition modules may call seal. Production boot may not, except boot.ts. */
const SEAL_ALLOWLIST = new Set([
  'boot.ts',
  'built-in-run-slots.ts',
  'core/cli-registry.ts',
  'core/runner-registry.ts',
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

it('seals all seven registries and runs beforeSeal only on the first full boot', async () => {
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
  const sealed = () => ({
    cli: cli.cliCommandsSealed(), runners: runners.runnersSealed(), slots: slots.runSlotsSealed(),
    workers: workers.workerExecutionsSealed(), steps: steps.stepKindsSealed(),
    tools: tools.agentToolsSealed(), waits: waits.waitKindsSealed(),
  });
  expect(Object.values(sealed()).some(Boolean)).toBe(false);
  await boot.bootRuntime({ beforeSeal: () => {
    order.push('hook');
    const state = sealed();
    expect(Object.values(state).every(value => value === false), JSON.stringify(state)).toBe(true);
  } });
  expect(order).toEqual(['hook']);
  expect(sealed()).toEqual({ cli: true, runners: true, slots: true, workers: true, steps: true, tools: true, waits: true });
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
  expect([
    runners.runnersSealed(), slots.runSlotsSealed(), workers.workerExecutionsSealed(),
    steps.stepKindsSealed(), tools.agentToolsSealed(), waits.waitKindsSealed(),
  ]).toEqual([false, false, false, false, false, false]);
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

it('seals registries from boot.ts and the registry definitions only', () => {
  const sealCall = /\bseal[A-Z][A-Za-z]*\(/;
  const sealFunction = /^\s*(?:export\s+)?(?:async\s+)?function\s+seal[A-Z]/m;
  const offenders = productionSources().filter(file => !SEAL_ALLOWLIST.has(file)).filter(file => {
    const source = readFileSync(join(srcRoot, file), 'utf8');
    return sealFunction.test(source) || sealCall.test(source);
  });
  expect(offenders).toEqual([]);
});
