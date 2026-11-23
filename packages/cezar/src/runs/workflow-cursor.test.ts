import { describe, expect, it } from 'vitest';
import type { RunStatus, WorkflowCursor } from '@open-mercato/cezar-contract';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { applyExit, type ExitRead } from './run-exits.ts';
import { decodeRunRow } from './run-decode.ts';

// ADR 0064, hearsay-tools/squawk#1621: the run exits are the only writers of the workflow cursor.
const start: WorkflowCursor = { stepId: 'review', mode: 'start' };
const resume: WorkflowCursor = { stepId: 'review', mode: 'resume' };
const run = (status: RunStatus, workflowCursor?: WorkflowCursor): ExitRead => ({ status, delegation: undefined, ...(workflowCursor ? { workflowCursor } : {}) });

describe('the workflow cursor, written by the run exits (ADR 0064)', () => {
  it('records the step a requeue names as the step the step loop starts', () => {
    expect(applyExit(run(RUN_STATUS.running), 'requeue', {}, { stepId: 'review', cursor: 'start' })).toMatchObject({ workflowCursor: start, status: RUN_STATUS.queued });
  });

  it('records a failed attempt that a Continue resumes, before the wake delivery decision and on a held failure', () => {
    for (const exit of ['fail-attempt', 'hold-failure'] as const) {
      expect(applyExit(run(RUN_STATUS.running), exit, {}, { stepId: 'review', cursor: 'resume' })).toHaveProperty('workflowCursor', resume);
    }
  });

  it('records a failed attempt alone, keeping the status and the park reason of a run its turn parked', () => {
    expect(applyExit(run(RUN_STATUS.running), 'fail-attempt', {}, { stepId: 'review', cursor: 'resume' }))
      .toStrictEqual({ workflowCursor: resume, status: RUN_STATUS.running });
    expect(applyExit({ ...run(RUN_STATUS.waiting), parkReason: 'turn' } as ExitRead, 'fail-attempt-parked', {}, { stepId: 'review', cursor: 'resume' }))
      .toStrictEqual({ workflowCursor: resume, status: RUN_STATUS.waiting });
  });

  it('leaves the cursor alone when the caller names no mode', () => {
    for (const exit of ['requeue', 'fail-attempt', 'hold-failure', 'park', 'fail'] as const) {
      expect(applyExit(run(RUN_STATUS.running, start), exit, {}, { stepId: 'review' })).not.toHaveProperty('workflowCursor');
    }
  });

  it('keeps the cursor through a failed setup and a Continue on the failed run', () => {
    expect(applyExit(run(RUN_STATUS.queued, start), 'fail-start', { error: 'worktree creation failed' })).not.toHaveProperty('workflowCursor');
    for (const exit of ['continue-line', 'continue-now'] as const) {
      expect(applyExit(run(RUN_STATUS.failed, start), exit)).not.toHaveProperty('workflowCursor');
    }
  });

  it('spends the cursor when the step loop enters its step, and only that step', () => {
    expect(applyExit(run(RUN_STATUS.queued, start), 'start', { currentStepId: 'review' }, { stepId: 'review' })).toHaveProperty('workflowCursor', undefined);
    expect(applyExit(run(RUN_STATUS.queued, start), 'start', { currentStepId: 'continue-2' })).not.toHaveProperty('workflowCursor');
    expect(applyExit(run(RUN_STATUS.queued, start), 'start-held')).not.toHaveProperty('workflowCursor');
  });

  it('retires the cursor when the run succeeds', () => {
    for (const exit of ['succeed', 'succeed-review'] as const) {
      expect(applyExit(run(RUN_STATUS.running, resume), exit)).toHaveProperty('workflowCursor', undefined);
    }
  });
});

describe('a saved row from before the workflow cursor', () => {
  it('reads its CI or provider-retry step as a cursor that resumes it, and stores only the cursor', () => {
    const saved = { ...makeRunRecord({ status: RUN_STATUS.waiting }), workflowResumeStepId: 'review' };
    const decoded = decodeRunRow(JSON.stringify(saved));
    expect(decoded?.run.workflowCursor).toEqual(resume);
    expect(decoded?.run).not.toHaveProperty('workflowResumeStepId');
    expect(decoded?.extras ?? {}).not.toHaveProperty('workflowResumeStepId');
  });

  it('reads a row with neither field as having no cursor', () => {
    expect(decodeRunRow(JSON.stringify(makeRunRecord({ status: RUN_STATUS.failed })))?.run.workflowCursor).toBeUndefined();
  });
});
