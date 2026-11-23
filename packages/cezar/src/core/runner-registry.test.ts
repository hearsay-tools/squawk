import { BUILT_IN_RUNNERS, registerBuiltInRunners } from '../runners/built-in.ts';
import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { describe, expect, it } from 'vitest';
import { ClaudeCliRunner } from '../runners/claude/claude-cli-runner.ts';
import { defineRunner } from './runner-definition.ts';
import { createRunner, isRegisteredRunner, registeredRunners, registerRunner, runnerDefinition, sealRunners } from './runner-registry.ts';
import { DEFAULT_RUNNER_ID, LEGACY_RUNNER_IDS } from './runner-ids.ts';

import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';

describe('registerRunner', () => {
  registerBuiltInRunners();
  sealRunners();

  it('keeps the built-in definitions and the data-only id list aligned (runners/ids.ts)', () => {
    expect(BUILT_IN_RUNNERS.map(definition => definition.id)).toEqual([...BUILT_IN_RUNNER_IDS]);
  });

  it('ignores the same definition registered again', () => {
    registerRunner(codexRunner);
    registerBuiltInRunners();
    expect(registeredRunners()).toEqual(BUILT_IN_RUNNERS);
  });

  it('refuses another definition with an id that is already registered', () => {
    const copy = defineRunner({ ...codexRunner });
    expect(() => registerRunner(copy)).toThrow("Runner registry: conflicting registration for 'codex'.");
    expect(runnerDefinition('codex')).toBe(codexRunner);
  });

  it('refuses a legacy id', () => {
    const legacy = defineRunner({ ...claudeRunner, id: 'claude-cli' as never });
    expect(() => registerRunner(legacy)).toThrow("Runner registry: reserved legacy key 'claude-cli'.");
    expect(isRegisteredRunner('claude-cli')).toBe(false);
  });
});

registerBuiltInRunners();

// The production factory the entry points inject (hearsay-tools/cezarion#2939).
describe('createRunner', () => {
  it.each(BUILT_IN_RUNNERS.map(definition => [definition.id, definition] as const))('builds the %s runner', async (id, definition) => {
    const runner = await createRunner(id);
    expect(runner.constructor).toBe((await definition.loadAdapter()).constructor);
    expect(runner.backend).toBe(id);
  });

  it.each([['claude-cli'], [undefined]] as const)('builds the claude runner for %s', async (id) => {
    expect(await createRunner(id)).toBeInstanceOf(ClaudeCliRunner);
  });

  it('builds the claude runner for an unknown stored string', async () => {
    expect(await createRunner('retired-runner' as never)).toBeInstanceOf(ClaudeCliRunner);
    expect(DEFAULT_RUNNER_ID).toBe('claude');
    expect(LEGACY_RUNNER_IDS.get('claude-cli')).toBe('claude');
  });
});
