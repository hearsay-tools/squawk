import { describe, expect, it } from 'vitest';
import { upgradeRemovedRunnerResult } from './legacy-run-rows.ts';
import { parseStoredSummary } from './run-summary-page.ts';
import { runSummarySchema } from '@open-mercato/cezar-contract/runs';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';

// hearsay-tools/squawk#3715: a collected result of a worker that ran on a removed runner stays readable.
describe('upgradeRemovedRunnerResult', () => {
  it('drops a removed runner from a saved worker result and keeps every other field', () => {
    const file = { result: { workerId: 'w', backend: 'cursor', model: 'auto' }, diffSnapshot: 'diff' };
    upgradeRemovedRunnerResult(file);
    expect(file).toEqual({ result: { workerId: 'w', model: 'auto' }, diffSnapshot: 'diff' });
  });

  it('leaves a live runner and malformed input untouched', () => {
    const live = { result: { backend: 'codex' } };
    upgradeRemovedRunnerResult(live);
    expect(live).toEqual({ result: { backend: 'codex' } });
    expect(() => upgradeRemovedRunnerResult(null)).not.toThrow();
    expect(() => upgradeRemovedRunnerResult({ result: 'x' })).not.toThrow();
  });
});

// hearsay-tools/squawk#3715: a settled row's stored summary skips the record parse, so it folds too.
describe('parseStoredSummary', () => {
  it('reads a stored summary of a run saved on a removed runner as removedRunner', () => {
    const summary = parseStoredSummary(JSON.stringify({ id: 'r', title: 't', status: RUN_STATUS.done, createdAt: '2026-01-01T00:00:00.000Z',
      archived: true, runner: 'cursor', currentStepBackend: 'cursor' }));
    expect(summary).toMatchObject({ id: 'r', removedRunner: 'cursor' });
    expect(summary).not.toHaveProperty('runner');
    expect(summary).not.toHaveProperty('currentStepBackend');
    expect(runSummarySchema.safeParse({ ...summary, workflow: 'quick-task', workflowLabel: 'quick-task', tokensUsed: 0 }).success).toBe(true);
  });
});
