import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS, makeRunRecord, makeStepState } from '@open-mercato/cezar-contract/test-factories.testkit';
import { accountHeldFor, deriveAccountHolds, queuedStartAt, resumeInFlight } from './run-scheduling.ts';
import type { WorkflowDef } from './types.ts';

sealTestRunners(claudeRunner);

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const later = new Date(NOW + 60_000).toISOString();
const same = <T>(run: T) => run;

// hearsay-tools/squawk#3337: a usage limit holds its account; a provider-error hold does not.
describe('account holds', () => {
  it('a usage-limit hold blocks its account until its resume time', () => {
    const holds = deriveAccountHolds([makeRunRecord({ status: RUN_STATUS.waiting, runner: 'claude', autoResumeAt: later })], same, NOW);
    expect(accountHeldFor(makeRunRecord({ status: RUN_STATUS.queued, runner: 'claude' }), holds, 'claude')).toBe(true);
  });

  // hearsay-tools/squawk#3715: the limit belonged to a runner Squawk no longer ships.
  it('a usage-limit hold on a removed runner blocks no live account', () => {
    const holds = deriveAccountHolds([makeRunRecord({ status: RUN_STATUS.waiting, removedRunner: 'cursor', autoResumeAt: later })], same, NOW);
    expect(holds.deadline.size).toBe(0);
    expect(holds.inFlight.size).toBe(0);
  });

  it('a provider-error hold blocks no account', () => {
    const holds = deriveAccountHolds([makeRunRecord({ status: RUN_STATUS.waiting, runner: 'claude', autoResumeAt: later, autoResumeReason: 'provider-error' })], same, NOW);
    expect(holds.deadline.size).toBe(0);
    expect(accountHeldFor(makeRunRecord({ status: RUN_STATUS.queued, runner: 'claude' }), holds, 'claude')).toBe(false);
  });

  it('a provider-error retry in flight holds no fresh work', () => {
    expect(resumeInFlight(makeRunRecord({ status: RUN_STATUS.running, autoResumeAttempts: 1 }))).toBe(true);
    expect(resumeInFlight(makeRunRecord({ status: RUN_STATUS.running, autoResumeAttempts: 1, autoResumeReason: 'provider-error' }))).toBe(false);
  });
});

// hearsay-tools/squawk#1621: a queued workflow tail starts at its `start` cursor (ADR 0064).
describe('queued start', () => {
  const workflow: WorkflowDef = { name: 'chain', source: 'file', steps: [{ id: 'implement' }, { id: 'review' }, { id: 'verify', command: 'true' }] };
  const steps = (implement: typeof STEP_STATUS.done | typeof STEP_STATUS.pending) => [
    makeStepState({ id: 'implement', status: implement }),
    makeStepState({ id: 'review', status: STEP_STATUS.pending }),
    makeStepState({ id: 'verify', kind: STEP_KIND.check, status: STEP_STATUS.pending }),
  ];

  it('starts at the step the cursor names', () => {
    expect(queuedStartAt(makeRunRecord({ status: RUN_STATUS.queued, steps: steps(STEP_STATUS.pending), workflowCursor: { stepId: 'review', mode: 'start' } }), workflow)).toBe(1);
  });

  it('starts at the first pending step without a start cursor', () => {
    expect(queuedStartAt(makeRunRecord({ status: RUN_STATUS.queued, steps: steps(STEP_STATUS.done) }), workflow)).toBe(1);
    expect(queuedStartAt(makeRunRecord({ status: RUN_STATUS.queued, steps: steps(STEP_STATUS.pending), workflowCursor: { stepId: 'review', mode: 'resume' } }), workflow)).toBe(0);
  });
});
