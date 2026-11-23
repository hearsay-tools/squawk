import { beforeEach, expect, it, vi } from 'vitest';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';

let registry: typeof import('./runner-registry.ts');
beforeEach(async () => {
  vi.resetModules();
  registry = await import('./runner-registry.ts');
});

it.each([false, true])('fails closed on all normal unsealed reads (registered: %s)', async registered => {
  if (registered) registry.registerRunner(claudeRunner);
  const reads = [
    () => registry.registeredRunners(), () => registry.isRegisteredRunner('claude'),
    () => registry.registeredRunnerId('claude'), () => registry.runnerDefinition('claude'),
    () => registry.resolveRunnerId(undefined), () => registry.resolveRunnerId('claude-cli'),
    () => registry.resolveRunnerId('unknown'),
  ];
  for (const read of reads) expect(read).toThrow(/Runner registry is unsealed: call registerBuiltInRunners\(\) then sealBuiltInRunners\(\)/);
  await expect(registry.createRunner(undefined)).rejects.toThrow(/Runner registry is unsealed/);
});

it('allows reference retries and rejects conflicts, legacy ids and new writes after seal', () => {
  expect(registry.runnersSealed()).toBe(false);
  registry.registerRunner(claudeRunner);
  registry.registerRunner(claudeRunner);
  for (const sealed of [false, true]) {
    if (sealed) registry.sealRunners();
    expect(() => registry.registerRunner({ ...claudeRunner })).toThrow(/conflicting registration/);
    expect(() => registry.registerRunner({ ...claudeRunner, id: 'claude-cli' })).toThrow(/reserved legacy key/);
    registry.registerRunner(claudeRunner);
  }
  expect(registry.runnersSealed()).toBe(true);
  expect(() => registry.registerRunner(codexRunner)).toThrow(/Runner registry is sealed/);
  registry.sealRunners();
  expect(registry.registeredRunners()).toEqual([claudeRunner]);
});

it.each([false, true])('keeps passive reads neutral until seal (registered: %s)', registered => {
  if (registered) registry.registerRunner(codexRunner);
  expect(registry.knownRunnerIds()).toEqual([]);
  expect(registry.savedRunnerRegistration('codex')).toBeUndefined();
  expect(registry.savedRunnerRegistration('unknown')).toBeUndefined();
  expect(registry.savedRunnerId('codex')).toBe('codex');
  expect(registry.savedRunnerId('unknown')).toBe('unknown');
  expect(registry.savedRunnerId('claude-cli')).toBe('claude');
  expect(registry.savedRunnerId(undefined)).toBeUndefined();
  registry.sealRunners();
  expect(registry.knownRunnerIds()).toEqual(registered ? ['codex'] : []);
  expect(registry.savedRunnerRegistration('codex')).toBe(registered);
  expect(registry.savedRunnerRegistration('unknown')).toBe(false);
  expect(registry.savedRunnerId('codex')).toBe(registered ? 'codex' : 'claude');
  expect(registry.savedRunnerId('unknown')).toBe('claude');
  expect(registry.savedRunnerId('claude-cli')).toBe('claude');
  expect(registry.savedRunnerId(undefined)).toBeUndefined();
  expect(registry.registeredRunners()).toEqual(registered ? [codexRunner] : []);
});

it('registers built-ins without sealing, so boot can add another definition', async () => {
  const builtIn = await import('../runners/built-in.ts');
  builtIn.registerBuiltInRunners();
  expect(registry.runnersSealed()).toBe(false);
  registry.registerRunner({ ...codexRunner, id: 'custom' });
  builtIn.sealBuiltInRunners();
  expect(registry.knownRunnerIds()).toEqual([...builtIn.BUILT_IN_RUNNERS.map(row => row.id), 'custom']);
});
