import { expect, it, vi } from 'vitest';
import { registerRunner } from '../core/runner-registry.ts';
import { antigravityRunner } from '../runners/antigravity/definition.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { missingModelChoices } from './choices.ts';

registerRunner(antigravityRunner); registerRunner(claudeRunner);

it('never starts a picker-only native session during task/worker model admission', async () => {
  const get = vi.fn(() => new Promise<never>(() => {}));
  expect(await missingModelChoices({ models: { get }, providers: async () => ({ providers: [] }) }, 'antigravity', 'native-model')).toBeUndefined();
  expect(get).not.toHaveBeenCalled();
});

it('does not start a picker-only probe while finding alternatives for another runner', async () => {
  const get = vi.fn(async (runner: string) => ({ runner, models: [{ id: 'known', label: 'Known', description: '' }], source: 'live' as const, stale: false }));
  expect(await missingModelChoices({ models: { get }, providers: async () => ({ providers: [] }) }, 'claude', 'unknown')).toMatchObject({ runner: 'claude', requestedModel: 'unknown', otherRunners: [] });
  expect(get).toHaveBeenCalledExactlyOnceWith('claude');
});
