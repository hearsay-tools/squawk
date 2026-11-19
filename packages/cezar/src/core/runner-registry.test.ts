import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { ClaudeCliRunner } from '../runners/claude/claude-cli-runner.ts';
import { CodexAppServerRunner } from '../runners/codex/codex-app-server-runner.ts';
import { OmpRunner } from '../runners/omp/omp-runner.ts';
import { OpencodeServerRunner } from '../runners/opencode/opencode-server-runner.ts';
import { PiRunner } from '../runners/pi/pi-runner.ts';
import { defineRunner } from './runner-definition.ts';
import { createRunner, DEFAULT_RUNNER_ID, isRegisteredRunner, LEGACY_RUNNER_IDS, registeredRunners, registerRunner, runnerDefinition } from './runner-registry.ts';
import { BUILT_IN_RUNNERS, registerBuiltInRunners } from '../runners/built-in.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';

describe('registerRunner', () => {
  registerBuiltInRunners();

  it('ignores the same definition registered again', () => {
    registerRunner(codexRunner);
    registerBuiltInRunners();
    expect(registeredRunners()).toEqual(BUILT_IN_RUNNERS);
  });

  it('refuses another definition with an id that is already registered', () => {
    const copy = defineRunner({ ...codexRunner });
    expect(() => registerRunner(copy)).toThrow('Runner codex is already registered by another definition.');
    expect(runnerDefinition('codex')).toBe(codexRunner);
  });

  it('refuses a legacy id', () => {
    const legacy = defineRunner({ ...claudeRunner, id: 'claude-cli' as never });
    expect(() => registerRunner(legacy)).toThrow('Runner id claude-cli is a legacy id for claude; no runner may register it.');
    expect(isRegisteredRunner('claude-cli')).toBe(false);
  });
});

describe('the built-in runners', () => {
  registerBuiltInRunners();

  it('list the ids of RUNNER_IDS, in the same order', () => {
    expect(BUILT_IN_RUNNERS.map(definition => definition.id)).toEqual([...RUNNER_IDS]);
    expect(registeredRunners().map(definition => definition.id)).toEqual([...RUNNER_IDS]);
  });
});

// The production factory the entry points inject (hearsay-tools/cezarion#2939).
describe('createRunner', () => {
  registerBuiltInRunners();
  const classes = { claude: ClaudeCliRunner, codex: CodexAppServerRunner, opencode: OpencodeServerRunner, pi: PiRunner, omp: OmpRunner };

  it.each(RUNNER_IDS)('builds the %s runner', async (id) => {
    const runner = await createRunner(id);
    expect(runner).toBeInstanceOf(classes[id]);
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
