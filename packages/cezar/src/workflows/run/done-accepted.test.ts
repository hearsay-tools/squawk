import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentInput, Wait } from '@open-mercato/cezar-contract';
import { makePeerWait, makePrWait, makeProcessWait, makeRunRecord, makeSubagentWait, makeTimerWait, makeWorkerRequestWait, makeWorkerWait, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentSession } from '../../core/agent-runner.ts';
import { createActiveRun } from '../active-run.ts';
import { owedAtDone, reconsideredBy } from './done-accepted.ts';
import { InputFlight } from './input-delivery.ts';

const resolved = <W extends Wait>(wait: W): W => ({ ...wait, phase: WAIT_PHASE.resolved, resolvedAt: new Date().toISOString() });
const input = (over: Partial<AgentInput> = {}): AgentInput => ({ id: randomUUID(), source: 'agent', parentRunId: randomUUID(), text: 'input', createdAt: new Date().toISOString(), ...over });
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
    const failed = { ...wait, outcomes: [{ workerId: wait.workerIds![0]!, status: 'failed' as const, observedAt: new Date().toISOString() }] };
    expect(reconsideredBy(makeRunRecord({ waits: [resolved(failed)] }), [wait.id])).toBe('a failed worker wait result');
  });

  it.each<[string, AgentInput, string | undefined]>([
    ['a progress note keeps it', input({ conversation: conversation('progress', 'peer') }), undefined],
    ['a reply keeps it', input({ conversation: conversation('reply') }), undefined],
    ['a lifecycle observation keeps it', input({ source: 'lifecycle' }), undefined],
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
    const resultInput = input({ id: result.id, source: 'lifecycle' });
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
      { kind: 'queued', input_id: queued.id, source: 'peer' },
    ]);
  });

  it('owes nothing for the flight that opened the turn on a harness that cannot report reads', () => {
    const opened = input();
    const state = live('unobservable');
    state.inputState.attachFlight(new InputFlight(session, [opened.id]));
    expect(owedAtDone(makeRunRecord({ agentInputs: [opened] }), state)).toEqual([]);
  });
});
