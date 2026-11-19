import { expect, it } from 'vitest';
import { createRunInputSchema } from './runs.ts';
import { automationCreateSchema, automationUpdateSchema } from './automation-requests.ts';
import { createAutomationInputSchema, updateAutomationInputSchema } from './automations.ts';
import { storedAutomationTaskSchema, writableAutomationTask } from './automation-storage.ts';

it('strips retired variants from run creation like other unknown keys', () => {
  expect(createRunInputSchema.parse({ workflow: 'quick-task', task: 'work', variants: 3 })).not.toHaveProperty('variants');
});

it.each([automationCreateSchema, automationUpdateSchema, createAutomationInputSchema, updateAutomationInputSchema])(
  'rejects retired variants as an ordinary unknown automation task key', (schema) => {
    const result = schema.shape.task.safeParse({ prompt: 'work', variants: 1 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toMatchObject([{ code: 'unrecognized_keys', keys: ['variants'] }]);
  },
);

it.each(['variants', 'generateFollowups', 'agentProfile'])('drops the saved key %s that the write schema refuses, so a stored task passes the write schema', (key) => {
  const stored = storedAutomationTaskSchema.parse({ prompt: 'work', effort: 'high', [key]: 2 });
  const writable = writableAutomationTask(stored);
  expect(writable).toEqual({ prompt: 'work', effort: 'high' });
  expect(automationUpdateSchema.shape.task.safeParse(writable).success).toBe(true);
});

it.each([1, 2, 3])('still reads saved automation variant count %i', (variants) => {
  expect(storedAutomationTaskSchema.parse({ prompt: 'work', variants }).variants).toBe(variants);
});
