import { expect, it } from 'vitest';
import { createRunner, DEFAULT_RUNNER_ID, isRegisteredRunner, LEGACY_RUNNER_IDS, registeredRunners, runnerDefinition } from './runner-registry.ts';

// This file registers no runner, so the registry is empty: an entry that forgot
// registerBuiltInRunners() fails at once instead of falling back to Claude.
it('throws on every definition read, naming the missing registration', async () => {
  for (const read of [() => registeredRunners(), () => isRegisteredRunner('claude'), () => runnerDefinition('claude')]) {
    expect(read).toThrow(/No runner is registered: call registerBuiltInRunners\(\)/);
  }
  await expect(createRunner('claude')).rejects.toThrow(/No runner is registered/);
});

it('still reads the default runner and the legacy ids', () => {
  expect(DEFAULT_RUNNER_ID).toBe('claude');
  expect([...LEGACY_RUNNER_IDS]).toEqual([['claude-cli', 'claude']]);
});
