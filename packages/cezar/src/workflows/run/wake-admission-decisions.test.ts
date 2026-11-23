import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS, makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { makeTimerWait } from '@open-mercato/cezar-contract/wait-factories.testkit';
import type { AgentSession } from '../../core/agent-runner.ts';
import { createActiveRun } from '../active-run.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';
import { cleanCloseFailsDelivery, shouldReparkWithoutWaits } from './wake-admission.ts';

function stateAtBoundary(boundary: boolean) {
  const state = createActiveRun({ cwd: '.', autonomous: false, pendingHumanAsk: false });
  const session: AgentSession = { open: true, result: Promise.resolve({ text: '', toolCalls: [], tokensUsed: 0 }),
    sendMessage: () => true, sendAgentMessage: () => Promise.resolve(), discardQueuedMessages() {},
    holdsHumanInput: () => false, end() {}, interrupt() {} };
  state.liveSession.attachSession(session);
  if (boundary) transitionTurnBoundary(state, { kind: 'turn-end', phase: 'ui-completed', session });
  return state;
}

afterEach(() => vi.restoreAllMocks());

describe('shouldReparkWithoutWaits', () => {
  it.each([
    { name: 'missing record', run: undefined, parked: true, boundary: true },
    { name: 'running record', run: makeRunRecord({ status: RUN_STATUS.running }), parked: true, boundary: true },
    { name: 'not parked', run: makeRunRecord({ status: RUN_STATUS.waiting }), parked: false, boundary: true },
    { name: 'not at boundary', run: makeRunRecord({ status: RUN_STATUS.waiting }), parked: true, boundary: false },
  ])('does not repark: $name', ({ run, parked, boundary }) => {
    expect(shouldReparkWithoutWaits(run, () => parked, stateAtBoundary(boundary))).toBe(false);
  });

  it.each([{ waits: undefined }, { waits: [] }, { waits: [makeTimerWait()] }])('reparks at the boundary only with no waits: %j', ({ waits }) => {
    const run = makeRunRecord({ status: RUN_STATUS.waiting, waits });
    expect(shouldReparkWithoutWaits(run, () => true, stateAtBoundary(true))).toBe(!waits?.length);
  });

  it('preserves equality when both session references are absent', () => {
    const state = createActiveRun({ cwd: '.', autonomous: false, pendingHumanAsk: false });
    expect(shouldReparkWithoutWaits(makeRunRecord({ status: RUN_STATUS.waiting }), () => true, state)).toBe(true);
  });
});

// hearsay-tools/squawk#1289: a clean close charges a failed wake only after a delivery attempt.
describe('cleanCloseFailsDelivery', () => {
  const session = stateAtBoundary(false).liveSession.session!;
  const unread = vi.fn(() => { throw Error('receipt read without a named input'); });

  it('charges nothing without an attempt and reads no owed delivery', () => {
    const owes = vi.fn(() => true);
    expect(cleanCloseFailsDelivery(undefined, unread, owes)).toBe(false);
    expect(owes).not.toHaveBeenCalled();
  });

  it('charges nothing for an attempt that named no input', () => {
    const owes = vi.fn(() => true);
    expect(cleanCloseFailsDelivery({ session, inputIds: [] }, ids => { expect(ids).toEqual([]); return true; }, owes)).toBe(false);
    expect(owes).not.toHaveBeenCalled();
  });

  it('charges an attempt only when an input it carried is owed again', () => {
    const attempt = { session, inputIds: ['first', 'second'], outcome: 'acknowledged' as const };
    const owes = vi.fn(() => true);
    expect(cleanCloseFailsDelivery(attempt, ids => { expect(ids).toEqual(['first', 'second']); return true; }, owes)).toBe(false);
    expect(owes).not.toHaveBeenCalled();
    expect(cleanCloseFailsDelivery(attempt, () => false, owes)).toBe(true);
    expect(cleanCloseFailsDelivery({ session, inputIds: ['first'] }, () => false, () => false)).toBe(false);
  });
});
