import { describe, expect, it, vi } from 'vitest';
import { WAIT_PHASE, WAIT_VIA, makeHumanWait, makePeerWait, makeProcessWait, makePrWait, makeRunRecord,
  makeSubagentWait, makeTimerWait, makeWorkerWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { Wait } from '@open-mercato/cezar-contract/waits';
import { SessionEndedBeforeAcknowledgement } from '../../core/agent-runner-values.ts';
import { acknowledgedExit, cappedTimersBeforeFlush, rejectedAcknowledgement } from './input-delivery.ts';

const cap = 40;
function fixture(spent: number, admitted: boolean, boundary: boolean) {
  const reads = {
    countAutomaticWakes: vi.fn((before?: { spent: number }) => before?.spent ?? spent),
    isAdmitted: vi.fn(() => admitted),
    atTurnBoundary: vi.fn(() => boundary),
  };
  return { reads };
}

describe('cappedTimersBeforeFlush', () => {
  it('uses the old budget snapshot even after the durable budget reset', () => {
    const timer = makeTimerWait({ phase: WAIT_PHASE.resolved });
    const run = makeRunRecord({ automaticWakes: 0, waits: [timer] });
    const before = { spent: cap };
    const f = fixture(0, true, true);
    expect(cappedTimersBeforeFlush(run, before, f.reads, cap)).toEqual([timer]);
    expect(f.reads.countAutomaticWakes).toHaveBeenCalledWith(before);
    expect(run.automaticWakes).toBe(0);
  });

  it.each([
    { spent: cap - 1, admitted: true, boundary: true },
    { spent: cap, admitted: false, boundary: true },
    { spent: cap + 1, admitted: false, boundary: true },
    { spent: cap, admitted: true, boundary: false },
  ])('leaves results owed for %j', row => {
    const f = fixture(row.spent, row.admitted, row.boundary);
    const run = makeRunRecord({ waits: [makeTimerWait({ phase: WAIT_PHASE.resolved })] });
    expect(cappedTimersBeforeFlush(run, undefined, f.reads, cap)).toEqual([]);
    expect(f.reads.countAutomaticWakes).toHaveBeenCalledWith(undefined);
  });

  it.each([cap, cap + 1])('returns only resolved charging results, oldest first, at %s', spent => {
    const resolved = { phase: WAIT_PHASE.resolved, resolvedAt: '2026-11-01T00:00:00.000Z' };
    const timer = makeTimerWait({ ...resolved, via: WAIT_VIA.cezar_wait, resolvedAt: '2026-11-01T00:00:01.000Z' });
    const monitoring = makeTimerWait(resolved);
    const process = makeProcessWait(resolved);
    const peer = makePeerWait(resolved);
    const timeout = makeSubagentWait({ ...resolved, result: { reason: 'timeout' } });
    const noncharging: Wait[] = [makePrWait(resolved), makeWorkerWait(resolved), makeHumanWait(resolved),
      makeSubagentWait({ ...resolved, result: { reason: 'settled' } }),
      makeTimerWait(), makeTimerWait({ phase: WAIT_PHASE.delivered })];
    const waits = [timer, monitoring, process, peer, timeout, ...noncharging];
    const run = makeRunRecord({ waits });
    const f = fixture(spent, true, true);
    const result = cappedTimersBeforeFlush(run, undefined, f.reads, cap);
    expect(result).toEqual([monitoring, process, peer, timeout, timer]);
    expect(result[0]).toBe(monitoring);
    expect(run.waits).toBe(waits);
    expect(run.waits).toEqual(waits);
  });

  it.each([{ waits: undefined }, { waits: [] }])('returns no charging results without waits: %j', ({ waits }) => {
    const f = fixture(cap, true, true);
    expect(cappedTimersBeforeFlush(makeRunRecord({ waits }), undefined, f.reads, cap)).toEqual([]);
  });
});

// hearsay-tools/squawk#3508: a clean close that aborts an acknowledgement in flight is a retryable
// closed-session delivery failure; a transport error on an open session still fails the step.
describe('rejectedAcknowledgement', () => {
  const reads = (overrides: Partial<Parameters<typeof rejectedAcknowledgement>[0]> = {}) =>
    ({ current: () => true, sessionFault: () => undefined, inputFault: () => undefined, ...overrides });
  const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

  it('records a rejection the session\'s own end() caused as closed', () => {
    expect(rejectedAcknowledgement(reads(), new SessionEndedBeforeAcknowledgement())).toBe('closed');

  });

  it.each([
    { name: 'a provider error status', error: new Error('POST /session/s/prompt_async → 500 ') },
    { name: 'an abort end() did not fire', error: aborted },
    { name: 'a transport close', error: new Error('codex app-server stdin closed') },
  ])('fails the step on $name', ({ error }) => {
    expect(rejectedAcknowledgement(reads(), error)).toBe('failed');
  });

  it.each([
    { name: 'a session that is no longer current', overrides: { current: () => false } },
    { name: 'a session fault already recorded', overrides: { sessionFault: () => 'provider error' } },
    { name: 'an input fault already latched', overrides: { inputFault: () => 'agent input delivery failed: earlier' } },
  ])('takes nothing from a rejection on $name', ({ overrides }) => {
    for (const error of [new SessionEndedBeforeAcknowledgement(), aborted]) expect(rejectedAcknowledgement(reads(overrides), error)).toBe('ignored');
  });
});

// hearsay-tools/squawk#1239: an acknowledgement after its turn ended checkpoints in the park; one
// during the turn shows the wake turn running.
describe('acknowledgedExit', () => {
  it.each([
    { name: 'a wake of results during its turn resumes its step', resumes: true, resolvedIds: ['w'], turnEnded: false, exit: { exit: 'resume', resumeStepId: 'task' } },
    { name: 'a wake of messages during its turn resumes the run only', resumes: true, resolvedIds: [], turnEnded: false, exit: { exit: 'resume', resumeStepId: undefined } },
    { name: 'a wake of results after its turn ended stays parked', resumes: true, resolvedIds: ['w'], turnEnded: true, exit: {} },
    { name: 'a wake of messages after its turn ended stays parked', resumes: true, resolvedIds: [], turnEnded: true, exit: {} },
    { name: 'steering input never moves the run', resumes: false, resolvedIds: [], turnEnded: false, exit: {} },
  ])('$name', ({ resumes, resolvedIds, turnEnded, exit }) => {
    expect(acknowledgedExit({ resumes, resolvedIds }, turnEnded, 'task')).toEqual(exit);
  });
});
