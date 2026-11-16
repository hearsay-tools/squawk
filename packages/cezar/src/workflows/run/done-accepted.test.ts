import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AgentInput, Wait } from '@open-mercato/cezar-contract';
import { agentInputSchema, workerOutcomeSchema } from '@open-mercato/cezar-contract/delegation';
import { makeHumanWait, makePeerWait, makePrWait, makeProcessWait, makeRunEvent, makeRunRecord, makeSubagentWait, makeTimerWait, makeWorkerRequestWait, makeWorkerWait, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentSession } from '../../core/agent-runner.ts';
import { createActiveRun } from '../active-run.ts';
import { acceptedDoneDelivery, factsAtDone, owedAtDone, reconsideredBy } from './done-accepted.ts';
import { acceptedDoneHolds } from './turn-settler.ts';
import { InputFlight } from './input-delivery.ts';
import { boundaryInputFixture } from './boundary-input-order.testkit.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';

const resolved = <W extends Wait>(wait: W): W => ({ ...wait, phase: WAIT_PHASE.resolved, resolvedAt: new Date().toISOString() });
const input = (over: Partial<AgentInput> = {}): AgentInput => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: randomUUID(), text: 'input', createdAt: new Date().toISOString(), ...over });
const timerAt = makeTimerWait({ registeredAt: '2026-11-16T10:00:00.000Z' });
const prAt = makePrWait({ registeredAt: '2026-11-16T10:00:00.000Z' });
const conversation = (kind: 'request' | 'progress' | 'follow-up' | 'reply', relationship?: 'peer') =>
  ({ senderRunId: randomUUID(), recipientRunId: randomUUID(), kind, ...(relationship ? { relationship } : {}) });

describe('input after an accepted done (hearsay-tools/squawk#2587)', () => {
  it.each<[string, Wait, string | undefined]>([
    ['a passed check keeps it', makePrWait({ result: { outcome: 'passed', headSha: 'a'.repeat(40), observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: false } }), undefined],
    ['a merged PR keeps it', makePrWait({ until: 'merge', result: { outcome: 'merged', headSha: 'a'.repeat(40), observedAt: new Date().toISOString(), checks: [], totalChecks: 0, truncated: false } }), undefined],
    ['a failed check withdraws it', makePrWait({ result: { outcome: 'failed', headSha: 'a'.repeat(40), observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: false } }), 'a failed pr wait result'],
    ['a fired timer keeps it', makeTimerWait(), undefined],
    ['a process that exited 0 keeps it', makeProcessWait({ result: { outcome: 'exited', exitCode: 0, observedAt: new Date().toISOString() } }), undefined],
    ['a process that exited 1 withdraws it', makeProcessWait({ result: { outcome: 'exited', exitCode: 1, observedAt: new Date().toISOString() } }), 'a failed process wait result'],
    ['a worker outcome keeps it', makeWorkerWait({ result: { reason: 'outcome' } }), undefined],
    ['a request that timed out withdraws it', makeWorkerRequestWait({ result: { reason: 'timeout' } }), 'a failed worker wait result'],
    ['a peer wait that timed out withdraws it', makePeerWait({ result: { reason: 'timeout' } }), 'a failed peer wait result'],
    ['an interrupted subagent wait withdraws it', makeSubagentWait({ result: { reason: 'interrupted' } }), 'a failed subagent wait result'],
  ])('%s', (_name, wait, reason) => {
    const run = makeRunRecord({ waits: [resolved(wait)] });
    expect(reconsideredBy(run, [wait.id])).toBe(reason);
  });

  it('a worker outcome that failed withdraws it', () => {
    const wait = makeWorkerWait({ result: { reason: 'outcome' } });
    const failed = { ...wait, outcomes: [{ workerId: wait.workerIds![0]!, status: workerOutcomeSchema.shape.status.enum.failed, observedAt: new Date().toISOString() }] };
    expect(reconsideredBy(makeRunRecord({ waits: [resolved(failed)] }), [wait.id])).toBe('a failed worker wait result');
  });

  it.each<[string, AgentInput, string | undefined]>([
    ['a progress note keeps it', input({ conversation: conversation('progress', 'peer') }), undefined],
    ['a reply keeps it', input({ conversation: conversation('reply') }), undefined],
    ['a lifecycle observation keeps it', input({ source: agentInputSchema.shape.source.enum.lifecycle }), undefined],
    ['a peer request withdraws it', input({ conversation: conversation('request', 'peer') }), 'a new peer request'],
    ['a family follow-up withdraws it', input({ conversation: conversation('follow-up') }), 'a new agent request'],
    ['the parent\'s instruction withdraws it', input(), 'a new instruction from the parent'],
  ])('%s', (_name, entry, reason) => {
    expect(reconsideredBy(makeRunRecord({ agentInputs: [entry] }), [entry.id])).toBe(reason);
  });
});

describe('input owed at cezar_done (hearsay-tools/squawk#2587)', () => {
  const session = { open: true, holdsHumanInput: () => false } as unknown as AgentSession;
  const live = (consumption: 'observable' | 'unobservable') => {
    const state = createActiveRun({ cwd: '.', pendingHumanAsk: false, autonomous: false });
    state.liveSession.attachSession(session);
    state.inputState.declareDelivery({ mode: 'steer', consumption, acknowledgement: 'response', humanInputAtTurnEnd: 'never-held', via: 'steer' });
    state.inputState.resetEarlyConsumption();
    state.inputState.resetUnreadInputs();
    return state;
  };

  it('lists a resolved result, queued input and an unread submission, and leaves out what this turn already has', () => {
    const result = resolved(makePrWait());
    const resultInput = input({ id: result.id, source: agentInputSchema.shape.source.enum.lifecycle });
    const queued = input({ conversation: conversation('progress', 'peer') });
    const opening = input();
    const read = input({ deliveredAt: new Date().toISOString(), consumedAt: new Date().toISOString() });
    const steered = input(), openedTurn = input(), unread = input({ deliveredAt: new Date().toISOString() });
    const state = live('observable');
    state.inputState.attachFlight(new InputFlight(session, [steered.id, openedTurn.id]));
    state.inputState.recordEarlyConsumption(openedTurn.id);
    state.inputState.recordUnreadInput(unread.id);
    state.inputState.selectOpeningInput(opening.id);
    const run = makeRunRecord({ waits: [result], agentInputs: [resultInput, queued, opening, read, steered, openedTurn, unread] });
    expect(owedAtDone(run, state)).toEqual([
      { kind: 'wait_result', wait_id: result.id, wait_kind: 'pr' },
      { kind: 'in_flight', input_id: steered.id },
      { kind: 'unread', input_id: unread.id },
      { kind: 'queued', input_id: queued.id, source: 'peer' },
    ]);
  });

  // B1: an acknowledgement is not a read (core/opencode-steering.test.ts): an instruction the
  // harness accepted and the model has not read is owed, in memory and on the saved row.
  it('owes delivered input the model has not read, also when only the saved row says so', () => {
    const unread = input({ deliveredAt: new Date().toISOString(), awaitingRead: true });
    expect(owedAtDone(makeRunRecord({ agentInputs: [unread] }), live('observable'))).toEqual([{ kind: 'unread', input_id: unread.id }]);
  });

  // The input submitted at the boundary that opened this turn is the turn's own, also on a harness
  // that reports its read only when the turn completes (Codex).
  it('owes no input that opened this turn, read or not', () => {
    const opener = input({ deliveredAt: new Date().toISOString(), awaitingRead: true });
    const state = live('observable');
    state.inputState.recordUnreadInput(opener.id);
    state.inputState.openTurnWith([opener.id]);
    expect(owedAtDone(makeRunRecord({ agentInputs: [opener] }), state)).toEqual([]);
  });

  it('owes no message the agent already read through its inbox', () => {
    const claimed = input({ inboxClaim: { receiptId: randomUUID(), generation: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    expect(owedAtDone(makeRunRecord({ agentInputs: [claimed] }), live('observable'))).toEqual([]);
  });

  // D1: a result the harness reported read before its acknowledgement is not owed again.
  it('owes no wait result whose delivery the harness already reported read', () => {
    const result = resolved(makeTimerWait());
    const state = live('observable');
    state.inputState.attachFlight(new InputFlight(session, [result.id]));
    state.inputState.recordEarlyConsumption(result.id);
    expect(owedAtDone(makeRunRecord({ waits: [result], agentInputs: [input({ id: result.id, source: agentInputSchema.shape.source.enum.lifecycle })] }), state)).toEqual([]);
  });

  it('owes nothing for the flight that opened the turn on a harness that cannot report reads', () => {
    const opened = input();
    const state = live('unobservable');
    state.inputState.attachFlight(new InputFlight(session, [opened.id]));
    expect(owedAtDone(makeRunRecord({ agentInputs: [opened] }), state)).toEqual([]);
  });
});

describe('whether an accepted done still holds at the turn end (hearsay-tools/squawk#2587)', () => {
  // Every fact is ordered by identity against what the run held at acceptance, never by clock
  // time: these cases put everything in the done's own millisecond.
  const at = '2026-11-16T10:00:00.000Z';
  type Row = Partial<Parameters<typeof makeRunRecord>[0]>;
  /** The run at the turn end, after `then` was the run when the done was accepted. */
  const decide = (then: Row, now: Row, events = [makeRunEvent({ type: 'user-message', seq: 9 })], turn = {}) => {
    const done = { session: 'generation', at, seq: 10, ...factsAtDone(makeRunRecord(then)) };
    return acceptedDoneHolds(makeRunRecord({ ...then, ...now, doneAccepted: done }), events, turn);
  };
  const holds = (now: Row = {}, events?: ReturnType<typeof makeRunEvent>[], turn = {}) => decide({}, now, events, turn);
  const kept = { holds: true };
  const withdrawn = (reason: string) => ({ holds: false, reason, byInput: expect.any(Boolean) });
  const earlier = input({ createdAt: at, deliveredAt: at, consumedAt: at });
  const pr = (outcome: 'failed' | 'passed') => ({ outcome, headSha: 'a'.repeat(40), observedAt: at, checks: [], totalChecks: 1, truncated: false });

  it.each<[string, Row, Row, { holds: boolean; reason?: string }]>([
    ['nothing after the done keeps it', {}, {}, kept],
    ['a progress note after the done keeps it', { agentInputs: [earlier] }, { agentInputs: [earlier, input({ createdAt: at, conversation: conversation('progress', 'peer') })] }, kept],
    // B2: a peer follow-up the message inbox acknowledged.
    ['a peer follow-up read through the inbox withdraws it', { agentInputs: [earlier] }, { agentInputs: [earlier, input({ createdAt: at, deliveredAt: at, conversation: conversation('follow-up', 'peer') })] }, withdrawn('a new peer request')],
    // B3: the opening input of a continuation that resumes a stopped worker.
    ['an agent request that opens a continuation withdraws it', {}, { agentInputs: [input({ createdAt: at, conversation: conversation('request') })] }, withdrawn('a new agent request')],
    ['the parent\'s steer in the done\'s millisecond withdraws it', { agentInputs: [earlier] }, { agentInputs: [earlier, input({ createdAt: at })] }, withdrawn('a new instruction from the parent')],
    ['an instruction from before the done keeps it', { agentInputs: [{ ...earlier, conversation: conversation('request') }] }, {}, kept],
    // B4: a peer wait from `hsq message wait --peer`, outside the tool.
    ['a peer wait registered through the CLI withdraws it', {}, { waits: [makePeerWait({ registeredAt: at, via: WAIT_VIA['cez-message-wait'] })] }, withdrawn('the agent registered a wait')],
    // Round 2, B2: a wait registered in the done's own millisecond.
    ['a wait registered in the done\'s millisecond withdraws it', {}, { waits: [makeTimerWait({ registeredAt: at })] }, withdrawn('the agent registered a wait')],
    // D2: a replayed registration registers nothing new.
    ['a wait registered before the done keeps it, also in its millisecond', { waits: [timerAt] }, { waits: [timerAt] }, kept],
    ['the completion wait keeps it', {}, { waits: [makeWorkerWait({ registeredAt: at, source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion })] }, kept],
    ['a question asked after the done withdraws it', {}, { waits: [makeHumanWait({ registeredAt: at })] }, withdrawn('the agent asked the user')],
    ['a failed result of a wait open at the done withdraws it', { waits: [prAt] }, { waits: [resolved({ ...prAt, resolvedAt: at, result: pr('failed') })] }, withdrawn('a failed pr wait result')],
    ['a passed result after the done keeps it', { waits: [prAt] }, { waits: [resolved({ ...prAt, resolvedAt: at, result: pr('passed') })] }, kept],
    ['a failed result settled before the done keeps it', { lastWaits: [{ ...prAt, phase: WAIT_PHASE.delivered, resolvedAt: at, result: pr('failed') }] }, {}, kept],
  ])('%s', (_name, then, now, expected) => {
    expect(decide(then, now)).toEqual(expected);
  });

  // The review's probe: a wait registered in the done's own millisecond is still after it.
  it('a wait registered in the same millisecond as the done, unknown to it, withdraws it', () => {
    const done = { session: 'generation', at, seq: 10, openWaits: [], settledWaits: [] };
    expect(acceptedDoneHolds(makeRunRecord({ doneAccepted: done, waits: [makeTimerWait({ registeredAt: at })] }), [])).toEqual(withdrawn('the agent registered a wait'));
  });

  it('a human message recorded after the done withdraws it; one before keeps it', () => {
    expect(holds({}, [makeRunEvent({ type: 'user-message', seq: 11 })])).toEqual(withdrawn('a new human message'));
    expect(holds({}, [makeRunEvent({ type: 'user-message', seq: 10 })])).toEqual(kept);
  });

  // A ScheduleWakeup in the turn that accepted the done loses to it (run-schedule-wakeup.test.ts);
  // one in a later turn is a wait the agent registers after it.
  it('a ScheduleWakeup in a later turn or a native question withdraws it', () => {
    expect(holds({}, [makeRunEvent({ type: 'turn.started', seq: 11 })], { scheduledWake: true })).toEqual(withdrawn('the agent scheduled a wake-up'));
    expect(holds({}, [makeRunEvent({ type: 'turn.started', seq: 8 })], { scheduledWake: true })).toEqual(kept);
    expect(holds({}, [], { nativeAsk: true })).toEqual(withdrawn('the agent asked the user'));
  });

  // B5: the done's free delivery turn is granted once; later deliveries charge as wakes do.
  it('grants one free delivery turn per accepted done', () => {
    const result = resolved(timerAt);
    const done = { session: 'generation', at, seq: 10, ...factsAtDone(makeRunRecord({ waits: [timerAt] })) };
    const run = makeRunRecord({ doneAccepted: done, waits: [result] });
    expect(acceptedDoneDelivery(run, [], [result.id])).toBe('free');
    expect(acceptedDoneDelivery({ ...run, doneAccepted: { ...done, freeTurn: true } }, [], [result.id])).toBe('kept');
    expect(acceptedDoneDelivery(makeRunRecord({ waits: [result] }), [], [result.id])).toBeUndefined();
  });
});

describe('the input that opened this turn (hearsay-tools/squawk#2587)', () => {
  // Round 2, B1: only a submission the transport accepted at a boundary opens the turn after it.
  // A refused one, and one retried after another turn started, is not this turn's own.
  it('owes an input refused at a boundary and retried mid-turn after a human turn started', async () => {
    const f = boundaryInputFixture();
    f.state.inputState.declareDelivery({ mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'never-held', via: 'steer' });
    f.state.inputState.resetUnreadInputs();
    f.state.inputState.resetEarlyConsumption();
    const retried = input({ parentRunId: f.run.id });
    f.store.commitAgentInputs(f.run.id, [retried]);
    transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'ui-completed', session: f.wire });
    vi.mocked(f.wire.sendAgentMessage).mockReturnValueOnce(false);
    expect(f.delivery.submitAgentInput(f.run.id, f.state, [{ type: 'text', text: 'retried' }], [retried.id])).toBe(false);
    expect(f.delivery.sendMessage(f.run.id, [{ type: 'text', text: 'A human turn' }])).toBe(true);
    transitionTurnBoundary(f.state, { kind: 'turn-started', phase: 'clear-boundary', session: f.wire });
    expect(f.delivery.submitAgentInput(f.run.id, f.state, [{ type: 'text', text: 'retried' }], [retried.id])).toBe(true);
    await f.state.inputState.agentInputFlight?.settled;
    expect(owedAtDone(f.store.getRun(f.run.id)!, f.state)).toEqual([{ kind: 'unread', input_id: retried.id }]);
  });
});
