import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { antigravityRunner } from '../runners/antigravity/definition.ts';
import { describe, expect, it } from 'vitest';
import { RUN_STATUS, STEP_KIND, STEP_STATUS, makeRunRecord, makeStepState } from '@open-mercato/cezar-contract/test-factories.testkit';
import { accountHeldFor as heldWithLock, deriveAccountHolds, queuedStartAt, resumeInFlight } from './run-scheduling.ts';
import type { WorkflowDef } from './types.ts';

sealTestRunners(claudeRunner, antigravityRunner);

const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const later = new Date(NOW + 60_000).toISOString();
const same = <T>(run: T) => run;
const accountHeldFor = (run: Parameters<typeof heldWithLock>[0], holds: Parameters<typeof heldWithLock>[1], fallbackRunner: string, modelsLocked = false) =>
  heldWithLock(run, holds, fallbackRunner, () => modelsLocked);

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

// hearsay-tools/squawk#4343: a limit closes the quota pool its model draws on, when the runner names
// one. Antigravity bills Gemini and third-party models from separate pools. `modelIdentity` is the
// model the launch resolver recorded for the latest turn; the runner's default model records none.
describe('quota pool holds', () => {
  const identity = (model: string | undefined) => (model ? `antigravity/${model}` : undefined);
  const held = (model: string | undefined, runner = 'antigravity') =>
    deriveAccountHolds([makeRunRecord({ status: RUN_STATUS.waiting, runner, model, modelIdentity: runner === 'antigravity' ? identity(model) : model, autoResumeAt: later })], same, NOW);
  const queued = (model: string | undefined, runner = 'antigravity') =>
    makeRunRecord({ status: RUN_STATUS.queued, runner, model, modelIdentity: runner === 'antigravity' ? identity(model) : model });
  const chain = (...models: string[]): WorkflowDef => ({ name: 'chain', source: 'file', steps: models.map((model, index) => ({ id: `s${index}`, model })) });

  it('a third-party hold leaves Gemini work free and blocks other third-party work', () => {
    const holds = held('claude-opus-5-5');
    expect(accountHeldFor(queued('gemini-4-neon'), holds, 'antigravity')).toBe(false);
    expect(accountHeldFor(queued('claude-sonnet-5-5'), holds, 'antigravity')).toBe(true);
  });

  it('a Gemini hold blocks Gemini work and leaves third-party work free', () => {
    const holds = held('gemini-4-neon');
    expect(accountHeldFor(queued('gemini-3.1-pro'), holds, 'antigravity')).toBe(true);
    expect(accountHeldFor(queued('claude-opus-5-5'), holds, 'antigravity')).toBe(false);
  });

  it('a pool hold blocks work on the auto model, whose pool is unknown', () => {
    expect(accountHeldFor(queued(undefined), held('claude-opus-5-5'), 'antigravity')).toBe(true);
    expect(accountHeldFor(queued(''), held('gemini-4-neon'), 'antigravity')).toBe(true);
  });

  it('a hold on the auto model closes the whole account', () => {
    const holds = held(undefined);
    expect(accountHeldFor(queued('gemini-4-neon'), holds, 'antigravity')).toBe(true);
    expect(accountHeldFor(queued('claude-opus-5-5'), holds, 'antigravity')).toBe(true);
  });

  it('a pool hold blocks only its own account', () => {
    const holds = held('gemini-4-neon');
    expect(accountHeldFor({ ...queued('gemini-4-neon'), agentProfile: 'work' }, holds, 'antigravity')).toBe(false);
    expect(accountHeldFor(queued('gemini-4-neon', 'claude'), holds, 'claude')).toBe(false);
  });

  it('a runner without pools keeps the account-wide hold', () => {
    const holds = held('opus', 'claude');
    expect([...holds.deadline]).toEqual(['claude:default']);
    expect(accountHeldFor(queued('sonnet', 'claude'), holds, 'claude')).toBe(true);
  });

  // With the models lock on, or after a Continue that switched the model, the turn records no
  // identity: the model the record names is not what ran.
  it('a turn that recorded no model identity holds the account, whatever model the record names', () => {
    const locked = makeRunRecord({ status: RUN_STATUS.waiting, runner: 'antigravity', model: 'gemini-4-neon', autoResumeAt: later });
    const holds = deriveAccountHolds([locked], same, NOW);
    expect(accountHeldFor(queued('claude-opus-5-5'), holds, 'antigravity')).toBe(true);
  });

  it('with the models lock on, a queued run runs the default model, so any pool hold blocks it', () => {
    expect(accountHeldFor(queued('gemini-4-neon'), held('claude-opus-5-5'), 'antigravity', true)).toBe(true);
  });

  it('reads the models lock only when the account holds a pool hold', () => {
    let reads = 0;
    const lock = () => { reads += 1; return false; };
    heldWithLock(queued('gemini-4-neon'), held('opus', 'claude'), 'antigravity', lock);
    heldWithLock(queued('gemini-4-neon'), held(undefined), 'antigravity', lock);
    expect(reads).toBe(0);
    expect(heldWithLock(queued('gemini-4-neon'), held('claude-opus-5-5'), 'antigravity', lock)).toBe(false);
    expect(reads).toBe(1);
  });

  it('a hold takes the pool of the model the turn ran on, not of another step', () => {
    const run = makeRunRecord({ status: RUN_STATUS.waiting, runner: 'antigravity', model: 'gemini-4-neon', modelIdentity: identity('claude-opus-5-5'), workflowDef: chain('gemini-4-neon', 'claude-opus-5-5'), autoResumeAt: later });
    const holds = deriveAccountHolds([run], same, NOW);
    expect(accountHeldFor(queued('gemini-4-neon'), holds, 'antigravity')).toBe(false);
    expect(accountHeldFor(queued('claude-sonnet-5-5'), holds, 'antigravity')).toBe(true);
  });

  it('a queued workflow whose steps draw on two pools is held by either pool', () => {
    const run = { ...queued('gemini-4-neon'), workflowDef: chain('claude-opus-5-5', 'gemini-4-neon') };
    expect(accountHeldFor(run, held('claude-opus-5-5'), 'antigravity')).toBe(true);
    expect(accountHeldFor(run, held('gemini-4-neon'), 'antigravity')).toBe(true);
  });

  it('a queued workflow whose steps all draw on one pool is free of the other pool', () => {
    const run = { ...queued('gemini-4-neon'), workflowDef: chain('gemini-4-neon', 'gemini-3.1-pro') };
    expect(accountHeldFor(run, held('claude-opus-5-5'), 'antigravity')).toBe(false);
    expect(accountHeldFor(run, held('gemini-4-neon'), 'antigravity')).toBe(true);
  });

  it('an in-flight third-party resume holds fresh third-party work, not Gemini work or other resumes', () => {
    const holds = deriveAccountHolds([makeRunRecord({ status: RUN_STATUS.running, runner: 'antigravity', model: 'claude-opus-5-5', modelIdentity: identity('claude-opus-5-5'), autoResumeAttempts: 1 })], same, NOW);
    expect(accountHeldFor(queued('claude-sonnet-5-5'), holds, 'antigravity')).toBe(true);
    expect(accountHeldFor(queued('gemini-4-neon'), holds, 'antigravity')).toBe(false);
    expect(accountHeldFor({ ...queued('claude-sonnet-5-5'), autoResumeAttempts: 1 }, holds, 'antigravity')).toBe(false);
  });

  // A hold key is never saved: every pump derives it from the record, so a run parked before
  // pools existed holds by its recorded model after an upgrade, and frees its pool on time.
  it('a run parked before the upgrade still holds, then frees its pool at its resume time', () => {
    const parked = makeRunRecord({ status: RUN_STATUS.waiting, runner: 'antigravity', model: 'claude-opus-5-5', modelIdentity: identity('claude-opus-5-5'), autoResumeAt: later, error: 'Third-party quota reached. Please switch to Gemini models. Resets in 4h14m' });
    expect(accountHeldFor(queued('claude-opus-5-5'), deriveAccountHolds([parked], same, NOW), 'antigravity')).toBe(true);
    const afterReset = deriveAccountHolds([parked], same, Date.parse(later) + 1);
    expect(accountHeldFor(parked, afterReset, 'antigravity')).toBe(false);
    expect(afterReset.deadline.size).toBe(0);
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
