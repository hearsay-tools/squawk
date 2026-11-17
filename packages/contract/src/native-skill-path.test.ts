import { STEP_KIND, STEP_STATUS } from './test-factories.testkit.ts';
import { expect, it } from 'vitest';
import { createRunInputSchema, stepStateSchema } from './runs.ts';
import { workflowDefSchema, workflowStepDefSchema } from './workflows.ts';
import { storedAutomationTaskSchema } from './automation-storage.ts';

const step = { id: 'task', skill: 'review', prompt: '{{task}}', skillPath: '.agents/skills/review/SKILL.md' };
it('accepts a selected path only on the inline run step and stored step', () => {
  expect(createRunInputSchema.parse({ task: 'work', steps: [step] }).steps?.[0]).toEqual(step);
  expect(stepStateSchema.parse({ id: 'task', name: 'Task', kind: STEP_KIND.agent, status: STEP_STATUS.pending, iterations: 0, tokensUsed: 0, skillPath: step.skillPath })).toHaveProperty('skillPath', step.skillPath);
  expect(workflowStepDefSchema.shape).not.toHaveProperty('skillPath');
  expect(workflowStepDefSchema.parse(step)).not.toHaveProperty('skillPath');
  expect(workflowDefSchema.parse({ name: 'review', source: 'built-in', steps: [step] }).steps[0]).not.toHaveProperty('skillPath');
  expect(storedAutomationTaskSchema.parse({ prompt: 'work', steps: [step] }).steps?.[0]).not.toHaveProperty('skillPath');
});
