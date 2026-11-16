import { describe, expect, it } from 'vitest';
import { upgradeRemovedRunnerResult } from './legacy-run-rows.ts';
import { parseStoredSummary } from './run-summary-page.ts';
import { runSummarySchema } from '@open-mercato/cezar-contract/runs';
import { RUN_STATUS, STEP_KIND, STEP_STATUS, makeStepState } from '@open-mercato/cezar-contract/test-factories.testkit';
import { removedRunnerStepAfter } from '../delegation/execution-identity.ts';

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

// A Continue appends its step, so a workflow step that ran later can sit before it: "latest" is by
// start time, as latestSessionStep reads it.
describe('removedRunnerStepAfter', () => {
  const step = (id: string, extra: Record<string, unknown>) => makeStepState({ id, kind: STEP_KIND.agent, status: STEP_STATUS.done, ...extra });

  it('finds no removed work when a live session started after it, wherever it sits in the list', () => {
    const steps = [step('implement', { startedAt: '2026-01-01T10:00:00.000Z' }),
      step('review', { sessionId: 'review-session', backend: 'codex', startedAt: '2026-01-01T10:02:00.000Z' }),
      step('continue-1', { removedBackend: 'cursor', startedAt: '2026-01-01T10:01:00.000Z' })];
    expect(removedRunnerStepAfter(steps, 'review-session')).toBeUndefined();
  });

  it('finds removed work that started after the latest live session', () => {
    const steps = [step('plan', { sessionId: 'plan-session', backend: 'codex', startedAt: '2026-01-01T10:00:00.000Z' }),
      step('build', { removedBackend: 'cursor', startedAt: '2026-01-01T10:01:00.000Z' })];
    expect(removedRunnerStepAfter(steps, 'plan-session')?.id).toBe('build');
  });
});
