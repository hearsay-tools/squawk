import { describe, expect, it } from 'vitest';
import { runEventSchema } from './events.ts';
import { runRecordSchema, stepStateSchema } from './runs.ts';
import { waitSchema } from './waits.ts';
import {
  RUN_STATUS,
  STEP_KIND,
  STEP_STATUS,
  makeRunEvent,
  makeRunRecord,
  makeStepState,
} from './test-factories.testkit.ts';
import {
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_SOURCE,
  WAIT_VIA,
  makeHumanWait,
  makePrWait,
  makeProcessWait,
  makeTimerWait,
  makeWorkerRequestWait,
  makeWorkerWait,
} from './wait-factories.testkit.ts';

/**
 * The typed test factories (hearsay-tools/cezarion#1812). A fixture built here is valid by the
 * contract's own schemas, and one that names a field the contract no longer has fails to compile.
 */

describe('the run record factory', () => {
  it('builds a record the contract accepts, and a step it accepts', () => {
    expect(runRecordSchema.parse(makeRunRecord())).toMatchObject({ status: RUN_STATUS.done, archived: false });
    expect(stepStateSchema.parse(makeStepState())).toMatchObject({ kind: STEP_KIND.agent });
  });

  it('applies the overrides over the defaults and keeps the rest', () => {
    const record = makeRunRecord({ status: RUN_STATUS.running, title: 'mine', steps: [makeStepState({ status: STEP_STATUS.running })] });
    expect(record).toMatchObject({ status: RUN_STATUS.running, title: 'mine', workflow: 'quick-task' });
    expect(record.steps[0]).toMatchObject({ status: STEP_STATUS.running, kind: STEP_KIND.agent });
  });

  it('gives each record its own id unless a test names one', () => {
    expect(makeRunRecord().id).not.toBe(makeRunRecord().id);
    expect(makeRunRecord({ id: 'mine' }).id).toBe('mine');
  });

  it('refuses a field the contract does not have, at compile time', () => {
    // `tsc` reports an unused directive here when the factory stops checking its overrides, so a
    // renamed `RunRecord` field cannot stay in a test unseen. The run proves only that it builds.
    // @ts-expect-error not a RunRecord field
    const record = makeRunRecord({ notARunRecordField: 1 });
    expect(record).toBeDefined();
    // @ts-expect-error a status the contract does not have
    expect(makeRunRecord({ status: 'finished' })).toBeDefined();
    // @ts-expect-error not a step field
    expect(makeStepState({ notAStepField: 1 })).toBeDefined();
  });
});

describe('the wait factories', () => {
  const all = () => [
    makeTimerWait(), makePrWait(), makeHumanWait(), makeWorkerWait(), makeWorkerRequestWait(), makeProcessWait(),
  ];

  it('build an entry the contract accepts, one for each kind', () => {
    const waits = all();
    for (const wait of waits) expect(waitSchema.parse(wait)).toEqual(wait);
    expect(waits.map((wait) => wait.kind)).toEqual([WAIT_KIND.timer, WAIT_KIND.pr, WAIT_KIND.human, WAIT_KIND.worker, WAIT_KIND.worker, WAIT_KIND.process]);
  });

  it('give each entry its own id, so a list of them has no duplicate', () => {
    const ids = [...all(), ...all()].map((wait) => wait.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('apply the overrides, and an entry stays valid with them', () => {
    const wait = makeTimerWait({ phase: WAIT_PHASE.resolved, via: WAIT_VIA['monitoring-line'], note: 'check CI' });
    expect(waitSchema.parse(wait)).toMatchObject({ kind: WAIT_KIND.timer, phase: WAIT_PHASE.resolved, via: WAIT_VIA['monitoring-line'], note: 'check CI' });
    expect(makeWorkerRequestWait({ source: WAIT_SOURCE.cezar })).toMatchObject({ source: WAIT_SOURCE.cezar });
  });

  it('refuse a field the entry does not have, at compile time', () => {
    // @ts-expect-error a timer has no `pid`
    expect(makeTimerWait({ pid: 7 })).toBeDefined();
    // @ts-expect-error a phase the contract does not have
    expect(makeHumanWait({ phase: 'parked' })).toBeDefined();
  });
});

describe('the event factories', () => {
  it('build an event with a sequence number and a time, and keep every key a test adds', () => {
    const event = makeRunEvent({ type: 'ask.requested', requestId: 'q' });
    expect(runEventSchema.parse(event)).toMatchObject({ type: 'ask.requested', requestId: 'q' });
    expect(makeRunEvent({ type: 'x' }).seq).not.toBe(makeRunEvent({ type: 'x' }).seq);
  });
});

describe('the enum constants', () => {
  // The other constants are their schema's own `.enum`; WAIT_KIND is assembled by hand.
  it('WAIT_KIND names every kind the wait schema holds', () => {
    expect(Object.values(WAIT_KIND).sort()).toEqual(waitSchema.options.map((entry) => entry.shape.kind.value).sort());
  });
});
