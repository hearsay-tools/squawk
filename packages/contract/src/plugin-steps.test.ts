import { expect, it } from 'vitest';
import { workflowStepDefSchema, providersRequiredByWorkflow } from './workflows.ts';
import { stepKindSchema } from './run-status.ts';
import { stepStateSchema } from './runs.ts';
import { STEP_KIND, makeStepState } from './test-factories.testkit.ts';

const plugin = { id: 'deploy', kind: STEP_KIND.plugin, pluginKind: 'deploy', config: { target: 'dev' } };
it('keeps plugin configuration and state, with no runner provider', () => {
  expect(workflowStepDefSchema.parse(plugin)).toEqual(plugin);
  expect(stepKindSchema.parse(STEP_KIND.plugin)).toBe(STEP_KIND.plugin);
  expect(stepStateSchema.parse(makeStepState({ kind: STEP_KIND.plugin, pluginKind: 'deploy' }))).toHaveProperty('pluginKind', 'deploy');
  expect(providersRequiredByWorkflow({ name: 'plugin', source: 'file', steps: [plugin, { id: 'check', command: 'true' }] }, 'codex', ['codex'])).toEqual([]);
  expect(providersRequiredByWorkflow({ name: 'agent', source: 'file', steps: [plugin, { id: 'agent', prompt: 'work' }] }, 'codex', ['codex'])).toEqual(['codex']);
});

it.each([
  { ...plugin, command: '' }, { ...plugin, prompt: '' },
  { ...plugin, prompt: 'work' }, { ...plugin, skill: 'work' }, { ...plugin, command: 'true' },
  { ...plugin, pluginKind: undefined }, { ...plugin, pluginKind: '' }, { ...plugin, pluginKind: 'x'.repeat(65) },
  { ...plugin, timeoutMs: 0 }, { ...plugin, runner: 'codex' }, { ...plugin, allowedTools: [] },
  { id: 'agent', prompt: 'work', pluginKind: 'deploy' },
  { id: 'check', command: 'true', config: {} },
])('rejects mixed or incomplete plugin steps: %j', step => {
  expect(workflowStepDefSchema.safeParse(step).success).toBe(false);
});
