import { expect, it, vi } from 'vitest';

it('fails closed, rejects conflicts, permits same-reference registration and seals once', async () => {
  vi.resetModules();
  const registry = await import('./step-kind-registry.ts');
  expect(registry.knownStepKinds()).toBeUndefined();
  expect(() => registry.registeredStepKinds()).toThrow(/unsealed.*registerBuiltInStepKinds/);
  expect(() => registry.stepKindDefinition('custom')).toThrow(/unsealed/);
  const definition = { kind: 'custom', requiresRunner: false, execute: async () => ({ kind: 'result' as const, ok: true, output: 'ok' }) };
  registry.registerStepKind(definition);
  registry.registerStepKind(definition);
  expect(() => registry.registerStepKind({ ...definition })).toThrow(/conflicting/);
  registry.registerBuiltInStepKinds();
  expect(registry.stepKindsSealed()).toBe(false);
  registry.sealStepKinds();
  registry.sealStepKinds();
  registry.registerStepKind(definition);
  registry.registerBuiltInStepKinds();
  expect(registry.stepKindDefinition('custom')).toBe(definition);
  expect(registry.knownStepKinds()).toEqual(['custom', 'agent', 'check']);
  expect(() => registry.registerStepKind({ ...definition, kind: 'late' })).toThrow(/sealed/);
  expect(() => registry.stepKindDefinition('missing')).toThrow(/Unknown/);
});
