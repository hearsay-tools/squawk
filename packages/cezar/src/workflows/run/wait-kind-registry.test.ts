import { beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { makePluginWait, WAIT_KIND, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/wait-factories.testkit';

beforeEach(() => vi.resetModules());

async function fixture() {
  const registry = await import('./wait-kind-registry.ts');
  const { BUILT_IN_WAIT_ROWS } = await import('./wait-kinds.ts');
  const schema = z.object({ kind: z.literal('fixture'), operation_id: z.uuid().optional(), target: z.string() });
  const row = { ...BUILT_IN_WAIT_ROWS.plugin, kind: 'fixture', isPlugin: true, requestKinds: ['fixture'],
    inputSchema: schema, inputs: [{ kind: 'fixture', order: 100, inputSchema: schema,
      properties: { target: { type: 'string' } }, descriptions: { target: 'The fixture target.' }, description: '"fixture" waits for a test signal.' }],
    answerKind: () => 'fixture' };
  return { ...registry, row };
}

it('fails closed on reads until sealed, with a boot hint', async () => {
  const registry = await fixture();
  expect(registry.waitKindsSealed()).toBe(false);
  expect(() => registry.waitKindRow('timer')).toThrow(/unsealed.*sealWaitKinds/);
  expect(() => registry.registeredWaitKinds()).toThrow(/unsealed/);
});

it('registers the same reference idempotently and rejects conflicts and new post-seal writes', async () => {
  const registry = await fixture();
  registry.registerWaitKind(registry.row);
  registry.registerWaitKind(registry.row);
  expect(() => registry.registerWaitKind({ ...registry.row })).toThrow(/conflicting/);
  registry.sealWaitKinds();
  expect(registry.waitKindsSealed()).toBe(true);
  registry.registerWaitKind(registry.row);
  expect(() => registry.registerWaitKind({ ...registry.row, kind: 'late', requestKinds: ['late'] })).toThrow(/sealed/);
  expect(registry.registeredWaitKinds()).toEqual([registry.row]);
  expect(registry.waitKindForWait(makePluginWait({ pluginKind: 'fixture' }))).toBe(registry.row);
  expect(registry.waitKindForWait(makePluginWait({ pluginKind: 'missing' }))).toBeUndefined();
});

it('imports the tool catalog before registration, then builds its schema lazily after seal', async () => {
  const registry = await fixture();
  const { flatWaitInputSchema, waitToolDefinition } = await import('../../ci-wait/tool-catalog.ts');
  expect(() => flatWaitInputSchema()).toThrow(/unsealed/);
  const { registerBuiltInWaitKinds } = await import('../../built-in-wait-kinds.ts');
  registerBuiltInWaitKinds();
  expect(registry.waitKindsSealed()).toBe(false);
  registry.registerWaitKind(registry.row);
  registry.sealWaitKinds();
  const schema = waitToolDefinition.inputSchema;
  expect(schema).toEqual(flatWaitInputSchema());
  expect(schema.properties.kind).toMatchObject({ enum: ['pr', 'worker', 'request', 'peer', 'timer', 'process', 'fixture'] });
  expect(schema.properties.target).toEqual({ type: 'string', description: 'The fixture target.' });
  expect(schema.properties.timeout_seconds).toMatchObject({ minimum: 1, maximum: 7200, default: 1800 });
  expect(schema.properties.seconds).toMatchObject({ minimum: 60, maximum: 7200 });
});

it('keeps the shipped flat schema exactly equal to the pre-registry schema', async () => {
  const { registerBuiltInWaitKinds, sealBuiltInWaitKinds } = await import('../../built-in-wait-kinds.ts');
  registerBuiltInWaitKinds();
  sealBuiltInWaitKinds();
  const { flatWaitInputSchema } = await import('../../ci-wait/tool-catalog.ts');
  const { default: baseline } = await import('./wait-input-defaults.fixture.json');
  expect(flatWaitInputSchema()).toEqual(baseline);
});

it('registers, repeats, resolves and cancels a custom wait through the tool and engine', async () => {
  const registry = await fixture();
  const { registerBuiltInWaitKinds } = await import('../../built-in-wait-kinds.ts');
  registerBuiltInWaitKinds();
  let watch!: import('./wait-kind-registry.ts').WaitWatchContext;
  const disarm = vi.fn();
  const dispose = vi.fn();
  registry.registerWaitKind({ ...registry.row,
    register: (request, context) => makePluginWait({ pluginKind: 'fixture', turnId: context.turnId,
      summary: `Target ${request.target}`, payload: { target: request.target }, deadline: undefined }),
    canonicalizePlugin: request => { request.target = String(request.target).toLowerCase(); },
    duplicatePlugin: (wait, request) => wait.payload.target === request.target,
    lifecycle: { arm: context => { watch = context; }, disarm, dispose },
  });
  registry.sealWaitKinds();
  const { waitRegistryFixture } = await import('../ci-wait-registration.testkit.ts');
  const f = waitRegistryFixture();
  const answer = await f.tools().registerWait({ kind: 'fixture', target: 'BUILD' }, WAIT_VIA.cezar_wait, new AbortController().signal);
  if (!('wait' in answer)) throw new Error(JSON.stringify(answer.answer));
  expect(answer.answer).toMatchObject({ ok: true, kind: 'fixture' });
  expect(answer.answer).not.toHaveProperty('deadline');
  expect(answer.wait).toMatchObject({ kind: WAIT_KIND.plugin, pluginKind: 'fixture', payload: { target: 'build' } });
  const repeated = await f.tools().registerWait({ kind: 'fixture', target: 'build' }, WAIT_VIA.cezar_wait, new AbortController().signal);
  if (!('wait' in repeated)) throw new Error(JSON.stringify(repeated.answer));
  expect(repeated.wait?.id).toBe(answer.wait?.id);
  watch.resolve({ signal: 'ready' });
  expect(f.waitById(answer.wait!.id)).toMatchObject({ phase: WAIT_PHASE.resolved, result: { signal: 'ready' } });
  expect(watch.signal.aborted).toBe(true);
  expect(disarm).toHaveBeenCalledOnce();
  const next = await f.tools().registerWait({ kind: 'fixture', target: 'next' }, WAIT_VIA.cezar_wait, new AbortController().signal);
  if (!('wait' in next)) throw new Error(JSON.stringify(next.answer));
  const cancelled = f.engine.cancel(f.run.id, [next.wait!.id]);
  expect(cancelled).toContainEqual(expect.objectContaining({ id: next.wait!.id, phase: WAIT_PHASE.cancelled }));
  expect(disarm).toHaveBeenCalledTimes(2);
  f.engine.disposeWatches();
  expect(dispose).toHaveBeenCalledOnce();
});

async function pluginRuntime(overrides: Partial<import('./wait-kind-registry.ts').WaitKindRegistration> = {}) {
  const registry = await fixture();
  const { registerBuiltInWaitKinds } = await import('../../built-in-wait-kinds.ts');
  registerBuiltInWaitKinds();
  registry.registerWaitKind({ ...registry.row,
    register: (request, context) => makePluginWait({ pluginKind: 'fixture', turnId: context.turnId,
      payload: { target: request.target }, deadline: new Date(Date.now() + 60_000).toISOString() }),
    duplicatePlugin: (wait, request) => wait.payload.target === request.target,
    ...overrides,
  });
  registry.sealWaitKinds();
  const { waitRegistryFixture } = await import('../ci-wait-registration.testkit.ts');
  return waitRegistryFixture();
}

it('deduplicates concurrent plugin handlers after each asynchronous registration finishes', async () => {
  const finish: (() => void)[] = [];
  const f = await pluginRuntime({ register: async (request, context) => {
    await new Promise<void>(resolve => { finish.push(resolve); });
    return makePluginWait({ pluginKind: 'fixture', turnId: context.turnId, payload: { target: request.target } });
  } });
  const signal = new AbortController().signal;
  const first = f.tools().registerWait({ kind: 'fixture', target: 'same' }, WAIT_VIA.cezar_wait, signal);
  const second = f.tools().registerWait({ kind: 'fixture', target: 'same' }, WAIT_VIA.cezar_wait, signal);
  expect(finish).toHaveLength(2);
  finish[0]!();
  const opened = await first;
  finish[1]!();
  const repeated = await second;
  if (!('wait' in opened) || !('wait' in repeated)) throw new Error('Expected two accepted registrations');
  expect(repeated.wait.id).toBe(opened.wait.id);
  expect(f.store.getRun(f.run.id)?.waits).toHaveLength(1);
  expect(repeated.answer).toMatchObject({ ok: true, deduplicated: true });
});

it('refuses invalid plugin input with invalid_request before running the handler', async () => {
  const register = vi.fn();
  const f = await pluginRuntime({ register });
  const response = await f.tools().registerWait({ kind: 'fixture', target: 123 }, WAIT_VIA.cezar_wait, new AbortController().signal);
  expect(response.answer).toMatchObject({ ok: false, effect: 'refused', code: 'invalid_request' });
  expect(register).not.toHaveBeenCalled();
});

it('ignores stale plugin observations after a deadline refresh', async () => {
  const watches: import('./wait-kind-registry.ts').WaitWatchContext[] = [];
  const f = await pluginRuntime({ lifecycle: { arm: context => { watches.push(context); } } });
  const opened = await f.tools().registerWait({ kind: 'fixture', target: 'refresh' }, WAIT_VIA.cezar_wait, new AbortController().signal);
  if (!('wait' in opened) || opened.wait.kind !== WAIT_KIND.plugin) throw new Error('Expected plugin wait');
  f.engine.refresh(f.run.id, opened.wait, { ...opened.wait, deadline: new Date(Date.now() + 120_000).toISOString() });
  expect(watches).toHaveLength(2);
  expect(watches[0]!.signal.aborted).toBe(true);
  watches[0]!.resolve({ stale: true });
  expect(f.waitById(opened.wait.id)?.phase).toBe(WAIT_PHASE.open);
  watches[1]!.resolve({ current: true });
  expect(f.waitById(opened.wait.id)).toMatchObject({ phase: WAIT_PHASE.resolved, result: { current: true } });
});

it.each([false, true])('uses the registered plugin slot policy when parking: keepsSlot=%s', async keepsSlot => {
  const f = await pluginRuntime({ keepsSlot });
  await f.tools().registerWait({ kind: 'fixture', target: 'park' }, WAIT_VIA.cezar_wait, new AbortController().signal);
  const { WakeAdmission } = await import('./wake-admission.ts');
  const { unused } = await import('../unused.testkit.ts');
  const line = unused<import('./run-line.ts').RunLine>('line', { park: vi.fn(), joinPool: vi.fn(), leavePool: vi.fn(() => true) });
  const host = unused<ConstructorParameters<typeof WakeAdmission>[1]>('wake host', {
    active: f.active, line, move: vi.fn(), queueWaitWake: vi.fn(), releaseSlot: vi.fn(),
  });
  const admission = new WakeAdmission(unused<import('./types.ts').RunModuleContext>('context', { store: f.store }), host, 40, 3);
  expect(admission.parkOnWaits(f.run.id, f.state)).toBe(true);
  expect(line.joinPool).toHaveBeenCalledTimes(keepsSlot ? 1 : 0);
  expect(line.leavePool).toHaveBeenCalledTimes(keepsSlot ? 0 : 1);
});
