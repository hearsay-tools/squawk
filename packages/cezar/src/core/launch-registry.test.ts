import { beforeEach, expect, it, vi } from 'vitest';
import type { Home } from '../home/home.ts';
import type { LaunchPartContext, LaunchPartDefinition } from './launch-registry.ts';

type Registry = typeof import('./launch-registry.ts');
let registry: Registry;

beforeEach(async () => {
  vi.resetModules();
  registry = await import('./launch-registry.ts');
});

const context: LaunchPartContext = {
  runId: 'run-1', dataDir: '/data', repoRoot: '/repo', home: {} as Home,
  cockpit: { origin: 'http://127.0.0.1:4321', projectId: 'project' }, env: { PROFILE: 'p' },
};

const part = (id: string, prompt: string | undefined, order?: number): LaunchPartDefinition =>
  ({ id, ...(order === undefined ? {} : { order }), contribute: () => ({ prompt }) });

it('runs parts in ascending order, defaults to 100 and keeps registration order on ties', async () => {
  registry.registerLaunchPart(part('late', 'late'));
  registry.registerLaunchPart(part('first', 'first', 10));
  registry.registerLaunchPart(part('tie-a', 'tie-a', 100));
  registry.registerLaunchPart(part('negative', 'negative', -5));
  registry.registerLaunchPart(part('after', 'after', 150));
  registry.sealLaunchParts();
  expect(registry.registeredLaunchParts().map(p => p.id)).toEqual(['negative', 'first', 'late', 'tie-a', 'after']);
  expect((await registry.resolveLaunchParts(context)).prompts).toEqual(['negative', 'first', 'late', 'tie-a', 'after']);
});

it('awaits async parts, folds env into later parts and skips empty prompts', async () => {
  const seen: Array<Readonly<Record<string, string>>> = [];
  registry.registerLaunchPart({ id: 'one', order: 1, contribute: async ({ env }) => { seen.push(env); return { env: { A: '1' }, prompt: 'one' }; } });
  registry.registerLaunchPart({ id: 'two', order: 2, contribute: ({ env }) => { seen.push(env); return { env: { B: env.A + '2' }, prompt: '' }; } });
  registry.registerLaunchPart({ id: 'three', order: 3, contribute: ({ env }) => { seen.push(env); return undefined; } });
  registry.sealLaunchParts();
  const resolved = await registry.resolveLaunchParts(context);
  expect(resolved).toEqual({ env: { A: '1', B: '12' }, prompts: ['one'] });
  expect(seen).toEqual([{ PROFILE: 'p' }, { PROFILE: 'p', A: '1' }, { PROFILE: 'p', A: '1', B: '12' }]);
  expect(Object.isFrozen(seen[1])).toBe(true);
});

it('warns once per failing part, names it and launches with the others', async () => {
  registry.registerLaunchPart({ id: 'throws', order: 1, contribute: () => { throw new Error('boom'); } });
  registry.registerLaunchPart({ id: 'rejects', order: 2, contribute: async () => { throw new Error('later'); } });
  registry.registerLaunchPart(part('works', 'works', 3));
  registry.sealLaunchParts();
  const warn = vi.fn();
  expect(await registry.resolveLaunchParts(context, warn)).toEqual({ env: {}, prompts: ['works'] });
  expect(warn.mock.calls).toEqual([
    [expect.stringMatching(/'throws'.*boom/)],
    [expect.stringMatching(/'rejects'.*later/)],
  ]);
});

it('refuses a duplicate id and accepts the same part again', () => {
  const same = part('same', 'x');
  registry.registerLaunchPart(same);
  registry.registerLaunchPart(same);
  expect(() => registry.registerLaunchPart(part('same', 'y'))).toThrow(/conflicting registration for 'same'/);
  expect(() => registry.checkLaunchPartRegistration(part('same', 'y'))).toThrow(/conflicting registration/);
});

const none = (): undefined => undefined;
it.each([
  ['an empty id', { id: '', contribute: none }, /invalid id/],
  ['a non-string id', { id: 7, contribute: none }, /invalid id/],
  ['a non-finite order', { id: 'x', order: Number.NaN, contribute: none }, /finite number order/],
  ['a string order', { id: 'x', order: '1', contribute: none }, /finite number order/],
  ['no contribute function', { id: 'x' }, /contribute function/],
])('refuses %s', (_name, value, message) => {
  const invalid = value as unknown as LaunchPartDefinition;
  expect(() => registry.checkLaunchPartRegistration(invalid)).toThrow(message);
  expect(() => registry.registerLaunchPart(invalid)).toThrow(message);
});

it('fails closed while unsealed and refuses registration once sealed', async () => {
  expect(registry.launchPartsSealed()).toBe(false);
  expect(() => registry.registeredLaunchParts()).toThrow(/Launch parts is unsealed/);
  await expect(registry.resolveLaunchParts(context)).rejects.toThrow(/Launch parts is unsealed/);
  registry.sealLaunchParts();
  expect(registry.launchPartsSealed()).toBe(true);
  expect(() => registry.registerLaunchPart(part('late', 'x'))).toThrow(/Launch parts is sealed/);
});
