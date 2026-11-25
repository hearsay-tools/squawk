import { describe, expect, it, vi } from 'vitest';
import { z as zod } from 'zod';
import type { SquawkPlugin, SquawkPluginApi } from './api.ts';
import type { AgentToolDefinition, CliCommandDefinition, RunnerDefinition, StepKindDefinition, WaitKindRow } from './index.ts';

/** Fresh process-wide registries and the api that writes them. */
async function fresh() {
  vi.resetModules();
  const api = await import('./api.ts');
  const runners = await import('../core/runner-registry.ts');
  const tools = await import('../ci-wait/tool-registry.ts');
  const waits = await import('../workflows/run/wait-kind-registry.ts');
  const steps = await import('../workflows/step-kind-registry.ts');
  const cli = await import('../core/cli-registry.ts');
  const slots = await import('../runs/removal-slots.ts');
  const lifecycle = await import('../runs/lifecycle-registry.ts');
  /** Seal every registry and read what it holds. */
  const committed = () => {
    runners.sealRunners(); tools.sealAgentTools(); waits.sealWaitKinds(); steps.sealStepKinds();
    cli.sealCliCommands(); slots.sealRunSlots(); lifecycle.sealRunLifecycleListeners();
    return {
      runners: runners.knownRunnerIds(),
      tools: tools.agentToolNames(),
      waits: waits.registeredWaitKinds().map(row => row.kind),
      steps: steps.knownStepKinds(),
      cli: cli.registeredCliCommands().map(command => command.name),
      gates: slots.deletionRefusal('run', 'history', '/data'),
      lifecycle: lifecycle.registeredRunLifecycleListeners().length,
    };
  };
  return { ...api, runners, tools, waits, steps, cli, slots, lifecycle, committed };
}

const runner = (id: string) => ({ id }) as unknown as RunnerDefinition;
const tool = (name: string) => ({ name }) as unknown as AgentToolDefinition;
const wait = (kind: string, requestKinds = [kind]) => ({ kind, requestKinds, isPlugin: true }) as unknown as WaitKindRow;
const step = (kind: string): StepKindDefinition => ({ kind, requiresRunner: false, execute: async () => ({ kind: 'next' }) });
const command = (name: string) => ({ name }) as unknown as CliCommandDefinition;
const gate = { name: 'plugin-gate', refuse: () => 'held by the plugin' };

/** One entry in every registry, then `last` runs inside setup. */
function everywhere(last: (api: SquawkPluginApi) => void | Promise<void> = () => {}): SquawkPlugin {
  return async (api) => {
    api.registerRunner(runner('fixture'));
    api.registerAgentTool(tool('fixture_tool'));
    api.registerWaitKind(wait('fixture-wait'));
    api.registerStepKind(step('fixture-step'));
    api.registerCliCommand(command('fixture-cmd'));
    api.registerRemovalSlots({ gates: [gate] });
    api.onRunLifecycle({ 'store.closed': () => {} });
    await last(api);
  };
}

const empty = { runners: [], tools: [], waits: [], steps: [], cli: [], gates: undefined, lifecycle: 0 };

describe('runPluginSetup', () => {
  it('commits every staged entry once setup ends cleanly', async () => {
    const env = await fresh();
    // A different definition under a live id would conflict; during setup nothing is live yet.
    const liveDuringSetup = () => {
      env.runners.checkRunnerRegistration(runner('fixture'));
      env.steps.checkStepKindRegistration(step('fixture-step'));
      env.cli.checkCliCommandRegistration(command('fixture-cmd'));
    };
    await env.runPluginSetup(everywhere(liveDuringSetup));
    expect(env.committed()).toEqual({
      runners: ['fixture'], tools: ['fixture_tool'], waits: ['fixture-wait'], steps: ['fixture-step'],
      cli: ['fixture-cmd'], gates: 'held by the plugin', lifecycle: 1,
    });
  });

  const rollbacks: Array<[string, (api: SquawkPluginApi) => void | Promise<void>, RegExp]> = [
    ['a synchronous throw', () => { throw new Error('setup broke'); }, /setup broke/],
    ['an async rejection', async () => { await Promise.resolve(); throw new Error('setup rejected'); }, /setup rejected/],
    ['a duplicate runner id in the plugin', api => api.registerRunner(runner('fixture')), /registers 'fixture' twice/],
    ['a duplicate CLI command in the plugin', api => api.registerCliCommand(command('fixture-cmd')), /registers 'fixture-cmd' twice/],
    ['a duplicate request kind in the plugin', api => api.registerWaitKind(wait('other-wait', ['fixture-wait'])), /request kind 'fixture-wait' twice/],
    ['the reserved runner id claude-cli', api => api.registerRunner(runner('claude-cli')), /reserved legacy key 'claude-cli'/],
    ['the reserved tool name ci-wait', api => api.registerAgentTool(tool('ci-wait')), /reserved legacy key 'ci-wait'/],
    ['an empty runner id', api => api.registerRunner(runner('')), /is not a stored runner id/],
    ['an untrimmed runner id', api => api.registerRunner(runner(' pad')), /is not a stored runner id/],
    ['a runner id over 64 characters', api => api.registerRunner(runner('r'.repeat(65))), /is not a stored runner id/],
    ['a runner id with a control character', api => api.registerRunner(runner('bad\u0007id')), /is not a stored runner id/],
    ['the step kind plugin', api => api.registerStepKind(step('plugin')), /Invalid workflow step kind 'plugin'/],
    ['an empty step kind', api => api.registerStepKind(step('')), /Invalid workflow step kind/],
    ['a step kind over 64 characters', api => api.registerStepKind(step('s'.repeat(65))), /Invalid workflow step kind/],
    ['a plugin wait kind with a built-in name', api => api.registerWaitKind(wait('timer')), /reserved or invalid kind 'timer'/],
    ['an empty tool name', api => api.registerAgentTool(tool('')), /invalid key/],
    ['removal slots that are not arrays', api => api.registerRemovalSlots({ gates: 'x' as never }), /must be an array/],
  ];
  it.each(rollbacks)('commits nothing in any registry after %s', async (_name, last, error) => {
    const env = await fresh();
    await expect(env.runPluginSetup(everywhere(last))).rejects.toThrow(error);
    expect(env.committed()).toEqual(empty);
  });

  it('commits nothing when a key is already live, and keeps the live entry', async () => {
    const env = await fresh();
    const live = step('fixture-step');
    env.steps.registerStepKind(live);
    await expect(env.runPluginSetup(everywhere())).rejects.toThrow(/conflicting registration for 'fixture-step'/);
    expect(env.committed()).toEqual({ ...empty, steps: ['fixture-step'] });
    expect(env.steps.stepKindDefinition('fixture-step')).toBe(live);
  });

  it('commits nothing when a live wait kind owns a staged request kind', async () => {
    const env = await fresh();
    env.waits.registerWaitKind(wait('live-wait', ['shared']));
    await expect(env.runPluginSetup(everywhere(api => api.registerWaitKind(wait('other', ['shared']))))).rejects.toThrow(/conflicting request kind 'shared'/);
    expect(env.committed()).toEqual({ ...empty, waits: ['live-wait'] });
  });

  it('commits nothing into a sealed registry', async () => {
    const env = await fresh();
    env.lifecycle.sealRunLifecycleListeners();
    await expect(env.runPluginSetup(everywhere())).rejects.toThrow(/Run lifecycle listeners is sealed/);
    expect(env.committed()).toEqual(empty);
  });

  it('accepts the same reference twice, as the live registries do', async () => {
    const env = await fresh();
    const definition = runner('fixture');
    await env.runPluginSetup(api => { api.registerRunner(definition); api.registerRunner(definition); });
    expect(env.committed().runners).toEqual(['fixture']);
  });

  it('refuses a register call after setup has ended', async () => {
    const env = await fresh();
    let kept: SquawkPluginApi | undefined;
    await env.runPluginSetup(api => { kept = api; });
    expect(() => kept?.registerRunner(runner('late'))).toThrow(/only while its setup function runs/);
    expect(env.committed()).toEqual(empty);
  });
});

describe('@hearsay-tools/squawk/plugin', () => {
  it('resolves to the plugin entry in tests and re-exports z', async () => {
    const plugin = await import('@hearsay-tools/squawk/plugin');
    expect(plugin.z).toBe(zod);
    expect(plugin.z.object({ ok: plugin.z.boolean() }).parse({ ok: true })).toEqual({ ok: true });
  });
});
