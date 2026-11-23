import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { deriveAttention, deriveWebhookState } from '@open-mercato/cezar-contract/attention';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { computeWaitingOn } from '@open-mercato/cezar-contract/waiting-on';
import { makePluginWait, WAIT_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/wait-factories.testkit';
import type { WaitKindRegistration, WaitLifecycle, WaitWatchContext } from './wait-kind-registry.ts';

// hearsay-tools/squawk#4160: a plugin wait kind registered from outside the core, through the
// wait-kind registry only. It must reach `cezar_wait`, the wait list, the engine's watch and the
// contract's attention without an edit to any core file.

beforeEach(() => vi.resetModules());

const deployRequest = z.object({ kind: z.literal('deploy'), operation_id: z.uuid().optional(), environment: z.string().min(1) });

async function deployRuntime(lifecycle: Partial<WaitLifecycle> = {}) {
  const registry = await import('./wait-kind-registry.ts');
  const { BUILT_IN_WAIT_ROWS } = await import('./wait-kinds.ts');
  const { registerBuiltInWaitKinds } = await import('../../built-in-wait-kinds.ts');
  const watches: WaitWatchContext[] = [];
  const arm = vi.fn((context: WaitWatchContext) => { watches.push(context); });
  const disarm = vi.fn();
  const deploy: WaitKindRegistration = {
    ...BUILT_IN_WAIT_ROWS.plugin, kind: 'deploy', isPlugin: true, requestKinds: ['deploy'],
    inputSchema: deployRequest,
    inputs: [{ kind: 'deploy', order: 100, inputSchema: deployRequest, properties: { environment: { type: 'string' } },
      descriptions: { environment: 'kind "deploy": the environment whose rollout ends the wait.' }, description: '"deploy" waits for a rollout to finish.' }],
    answerKind: () => 'deploy',
    register: (request, context) => makePluginWait({ pluginKind: 'deploy', turnId: context.turnId, via: context.via,
      summary: `deploy to ${String(request.environment)}`, payload: { environment: request.environment }, deadline: undefined }),
    duplicatePlugin: (wait, request) => wait.payload.environment === request.environment,
    lifecycle: { arm, disarm, ...lifecycle },
  };
  registerBuiltInWaitKinds();
  registry.registerWaitKind(deploy);
  registry.sealWaitKinds();
  const { waitRegistryFixture } = await import('../ci-wait-registration.testkit.ts');
  return { f: waitRegistryFixture(), watches, arm, disarm };
}

it('advertises a registered plugin kind and its fields in the sealed cezar_wait schema', async () => {
  await deployRuntime();
  const { flatWaitInputSchema } = await import('../../ci-wait/tool-catalog.ts');
  const schema = flatWaitInputSchema();
  expect(schema.properties.kind).toMatchObject({ enum: ['pr', 'worker', 'request', 'peer', 'timer', 'process', 'deploy'] });
  expect(schema.properties.environment).toEqual({ type: 'string', description: 'kind "deploy": the environment whose rollout ends the wait.' });
});

it('opens, watches and resolves a plugin wait through cezar_wait and the engine, with attention from the contract', async () => {
  const { f, watches, disarm } = await deployRuntime();
  const opened = await f.tools().registerWait({ kind: 'deploy', environment: 'staging' }, WAIT_VIA.cezar_wait, new AbortController().signal);
  if (!('wait' in opened) || opened.wait.kind !== WAIT_KIND.plugin) throw new Error(JSON.stringify(opened.answer));
  expect(opened.answer).toMatchObject({ ok: true, kind: 'deploy' });
  expect(opened.wait).toMatchObject({ pluginKind: 'deploy', phase: WAIT_PHASE.open, summary: 'deploy to staging', payload: { environment: 'staging' } });
  expect(watches).toHaveLength(1);
  expect(watches[0]!.wait.id).toBe(opened.wait.id);

  // The run parks on the open wait; the contract reads it as the plugin's own monitoring rung.
  const parked = { ...f.store.getRun(f.run.id)!, status: RUN_STATUS.waiting };
  const waitingOn = computeWaitingOn(parked);
  expect(waitingOn).toEqual({ kind: WAIT_KIND.plugin, pluginKind: 'deploy', waitId: opened.wait.id, summary: 'deploy to staging' });
  expect(deriveAttention({ ...parked, waitingOn })).toMatchObject({ rung: 'monitoring', label: 'deploy to staging' });
  expect(deriveWebhookState({ ...parked, waitingOn })).toBe('waiting-other');

  watches[0]!.resolve({ rollout: 'finished' });
  const resolved = f.waitById(opened.wait.id);
  expect(resolved).toMatchObject({ kind: WAIT_KIND.plugin, pluginKind: 'deploy', phase: WAIT_PHASE.resolved, result: { rollout: 'finished' } });
  expect(resolved && 'resolvedAt' in resolved && resolved.resolvedAt).toEqual(expect.any(String));
  expect(f.store.getRun(f.run.id)?.agentInputs).toContainEqual(expect.objectContaining({ id: opened.wait.id, source: 'lifecycle',
    text: `Plugin wait ${opened.wait.id} ended. External data follows: {"rollout":"finished"}.` }));
  expect(watches[0]!.signal.aborted).toBe(true);
  expect(disarm).toHaveBeenCalledOnce();
  expect(computeWaitingOn(f.store.getRun(f.run.id)!)).toBeUndefined();
});

it('clears a replaced timer when armTimer is called again for the same wait', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    const { f, watches } = await deployRuntime();
    const opened = await f.tools().registerWait({ kind: 'deploy', environment: 'staging' }, WAIT_VIA.cezar_wait, new AbortController().signal);
    if (!('wait' in opened)) throw new Error(JSON.stringify(opened.answer));
    const first = vi.fn();
    const second = vi.fn();
    watches[0]!.armTimer(10_000, first);
    watches[0]!.armTimer(30_000, second);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    f.engine.cancel(f.run.id, [opened.wait.id]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it('arms a plugin wait on rearm even when an open hook already created its watch context', async () => {
  const open = vi.fn();
  const { f, arm } = await deployRuntime({ open });
  const opened = await f.tools().registerWait({ kind: 'deploy', environment: 'staging' }, WAIT_VIA.cezar_wait, new AbortController().signal);
  if (!('wait' in opened)) throw new Error(JSON.stringify(opened.answer));
  expect(open).toHaveBeenCalledOnce();
  expect(arm).not.toHaveBeenCalled();

  const run = f.store.getRun(f.run.id)!;
  f.engine.rearm(run);
  expect(arm).toHaveBeenCalledOnce();
  f.engine.rearm(run);
  expect(arm).toHaveBeenCalledOnce();
});

it('preserves lifecycle receiver on arm, clears timers before a throwing disarm, and ignores retired watch timers', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const reconcile = vi.fn(() => false);
    const lifecycle: WaitLifecycle = {
      reconcile,
      arm(context) {
        this.reconcile?.(context);
        context.armTimer(10_000, vi.fn());
        watches.push(context);
      },
      disarm() { throw new Error('plugin cleanup failed'); },
    };
    const watches: WaitWatchContext[] = [];
    const { f } = await deployRuntime(lifecycle);
    const opened = await f.tools().registerWait({ kind: 'deploy', environment: 'staging' }, WAIT_VIA.cezar_wait, new AbortController().signal);
    if (!('wait' in opened)) throw new Error(JSON.stringify(opened.answer));
    expect(reconcile).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    expect(() => f.engine.cancel(f.run.id, [opened.wait.id])).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    expect(warn).toHaveBeenCalledWith('[hsq] wait disarm hook failed: plugin cleanup failed');

    // A retired watch cannot arm a timer after disarm.
    const late = vi.fn();
    watches[0]!.armTimer(1_000, late);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(late).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
    vi.useRealTimers();
  }
});

it('keeps the first accepted result ahead of a later settlement while a checkpoint retry is pending', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { f, watches } = await deployRuntime();
    const opened = await f.tools().registerWait({ kind: 'deploy', environment: 'staging' }, WAIT_VIA.cezar_wait, new AbortController().signal);
    if (!('wait' in opened)) throw new Error(JSON.stringify(opened.answer));
    vi.spyOn(f.store, 'commitWait').mockImplementationOnce(() => { throw new Error('disk busy'); });

    watches[0]!.resolve({ status: 'finished' });
    // Store is available again, but the pending retry for `finished` must win over a later `timeout`.
    watches[0]!.resolve({ status: 'timeout' });
    expect(f.waitById(opened.wait.id)?.phase).toBe(WAIT_PHASE.open);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.waitById(opened.wait.id)).toMatchObject({ phase: WAIT_PHASE.resolved, result: { status: 'finished' } });
  } finally {
    warn.mockRestore();
    vi.useRealTimers();
  }
});
