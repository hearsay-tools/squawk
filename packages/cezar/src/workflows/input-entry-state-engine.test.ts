import '../runners/claude/claude-runner.testkit.ts';
import { beforeEach, expect, it, vi } from 'vitest';
import { CLAUDE_SPEC_SUPPORT } from '../runners/claude/spec-support.ts';
import { randomUUID } from 'node:crypto';
import type { AgentRunResult } from '../core/agent-runner.ts';
import { RUN_STATUS, STEP_KIND, STEP_STATUS, makeTimerWait } from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { createActiveRun } from './active-run.ts';
import type { InputGroup } from './run/input-delivery.ts';
import { runnerHook, setupMonitoringFixture, waitForProduct } from './run-fixture.testkit.ts';

vi.mock('./active-run.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./active-run.ts')>();
  return { ...actual, createActiveRun: vi.fn((...args: Parameters<typeof actual.createActiveRun>) => {
    const state = actual.createActiveRun(...args);
    expectEmptyInput(state.inputState);
    return state;
  }) };
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function expectEmptyInput(group: InputGroup): void {
  expect(group.agentInputError).toBeUndefined();
  expect(group.agentInputFlight).toBeUndefined();
  expect(group.inputDelivery).toBeUndefined();
  expect(group.unreadInputIds).toBeUndefined();
  expect(group.consumedBeforeAck).toBeUndefined();
  expect(group.bundledInputIds).toBeUndefined();
  expect(group.retiredInFlight).toBeUndefined();
  expect(group.unreadInputTimer).toBeUndefined();
  expect(group.unreadRetried).toBeUndefined();
  expect(group.heldHumanInputTimer).toBeUndefined();
  expect(group.heldHumanInputSince).toBeUndefined();
  expect(group.heldHumanInputExpired).toBeUndefined();
  expect(group.openingAnswerAskSeq).toBeUndefined();
  expect(group.openingAgentInputId).toBeUndefined();
  expect(group.writingInput).toBeUndefined();
}

const f = setupMonitoringFixture();
const policy = { mode: 'steer' as const, consumption: 'observable' as const, acknowledgement: 'response' as const, humanInputAtTurnEnd: 'never-held' as const, via: 'entry-state fixture' };
let opened = deferred<void>();
let openedGroups: InputGroup[];
let sendAck: Promise<void>;
let holdsInput: boolean;
let closeWire: () => void;
let reportConsumed: (ids: readonly string[]) => void;
beforeEach(() => {
  vi.mocked(createActiveRun).mockClear();
  openedGroups = [];
  sendAck = Promise.resolve();
  holdsInput = false;
  opened = deferred<void>();
  runnerHook.runner = {
    backend: 'claude', specSupport: CLAUDE_SPEC_SUPPORT, systemPromptOnResume: 'resent', inputDelivery: policy,
    run: async () => ({ text: '', toolCalls: [], tokensUsed: 0 }), interrupt: async () => {},
    startSession(_spec, onEvent, options) {
      const calls = vi.mocked(createActiveRun).mock.results;
      const last = calls.at(-1);
      if (!last || last.type !== 'return') throw new Error('runner opened without the ActiveRun factory');
      const group = last.value.inputState;
      expect(group.inputDelivery).toEqual(policy);
      expect([...group.unreadInputIds!]).toEqual([]);
      expect([...group.consumedBeforeAck!]).toEqual([]);
      expect(group.agentInputFlight).toBeUndefined();
      expect(group.retiredInFlight).toBeUndefined();
      expect(group.unreadRetried).toBeUndefined();
      expect(group.bundledInputIds).toBeUndefined();
      expect(group.unreadInputTimer).toBeUndefined();
      expect(group.heldHumanInputTimer).toBeUndefined();
      expect(group.heldHumanInputSince).toBeUndefined();
      expect(group.heldHumanInputExpired).toBeUndefined();
      expect(group.writingInput).toBeUndefined();
      openedGroups.push(group);
      const result = deferred<AgentRunResult>();
      let open = true;
      const close = () => { open = false; result.resolve({ text: '', toolCalls: [], tokensUsed: 0 }); };
      closeWire = close;
      reportConsumed = ids => options?.onAgentInputConsumed?.(ids);
      queueMicrotask(() => { onEvent?.({ type: 'session', sessionId: 'input-entry-session', resumed: false }); opened.resolve(); });
      return { get open() { return open; }, result: result.promise, sendMessage: () => true,
        sendAgentMessage: () => sendAck, discardQueuedMessages: () => {}, holdsHumanInput: () => holdsInput,
        end: close, interrupt: close };
    },
  };
});

it('a fresh run constructs absent input optionals before initializing its delivery sets', async () => {
  const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await opened.promise;
  expect(createActiveRun).toHaveBeenCalledOnce();
  expect(openedGroups).toHaveLength(1);
});

it('Continue constructs a new input owner with absent optionals before delivery setup', async () => {
  const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await opened.promise;
  expect(f.manager.finish(record.id)).toBe(true);
  await waitForProduct(f.manager, f.store, () => !f.manager.isActive(record.id));
  opened = deferred<void>();
  expect(f.manager.continueRun(record.id, { text: 'continue' })).toEqual({ ok: true });
  await opened.promise;
  expect(createActiveRun).toHaveBeenCalledTimes(2);
  expect(openedGroups).toHaveLength(2);
  expect(openedGroups[1]).not.toBe(openedGroups[0]);
  expect(openedGroups[1]?.unreadInputIds).not.toBe(openedGroups[0]?.unreadInputIds);
});

it('restart recovery constructs absent input optionals before continuation delivery setup', async () => {
  const record = f.store.createRun({ title: 'interrupted', workflow: 'quick-task', task: 'work', runner: 'claude',
    steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] });
  f.currentId = record.id;
  setRunStatus(f.store, record.id, RUN_STATUS.running, { currentStepId: 'task', workflowDef: f.SINGLE_STEP });
  f.store.updateStep(record.id, 'task', { status: STEP_STATUS.running, sessionId: 'interrupted-session', backend: 'claude' });
  await f.manager.recover();
  await opened.promise;
  expect(createActiveRun).toHaveBeenCalledOnce();
  expect(openedGroups).toHaveLength(1);
});

async function openInputRun() {
  const record = f.manager.startRun(f.SINGLE_STEP, { task: 'work', runner: 'claude', worktree: false });
  f.currentId = record.id;
  await opened.promise;
  f.store.commitDelegation([{ id: record.id, delegation: { role: 'root', permissions: [], receipts: [] } }]);
  const group = openedGroups[0]!;
  const input = (text: string) => ({ id: randomUUID(), parentRunId: record.id, source: 'lifecycle' as const,
    text, createdAt: new Date().toISOString() });
  return { record, group, input };
}

it('keeps accepted unread input delivered until the closing session flight settles', async () => {
  const { record, group, input } = await openInputRun();
  const accepted = input('already accepted');
  const pending = input('ACK still pending');
  f.store.commitAgentInputs(record.id, [accepted, pending]);
  f.store.commitOutcome(record.id, { kind: 'delivered', inputIds: [accepted.id], at: new Date().toISOString(), awaitingRead: true });
  group.recordUnreadInput(accepted.id);
  const ack = deferred<void>();
  sendAck = ack.promise;
  f.manager.deliverConversationInput(record.id);
  const flight = group.agentInputFlight!;
  expect(flight.settled).toBeInstanceOf(Promise);
  const requeued = deferred<void>();
  let flightAtRequeue: InputGroup['agentInputFlight'];
  const commit = f.store.commitOutcome.bind(f.store);
  const checkpoint = vi.spyOn(f.store, 'commitOutcome').mockImplementation((...args) => {
    const outcomes = Array.isArray(args[1]) ? args[1] : [args[1]];
    if (outcomes.some(outcome => outcome.kind === 'requeued' && outcome.inputIds.includes(accepted.id))) {
      flightAtRequeue = group.agentInputFlight;
      requeued.resolve();
    }
    return commit(...args);
  });
  closeWire();
  expect(f.store.getRun(record.id)?.agentInputs?.find(entry => entry.id === accepted.id)?.deliveredAt).toBeDefined();
  expect(group.agentInputFlight).toBe(flight);
  ack.resolve();
  await requeued.promise;
  expect(flightAtRequeue).toBeUndefined();
  expect(f.store.getRun(record.id)?.agentInputs?.find(entry => entry.id === accepted.id)?.deliveredAt).toBeUndefined();
  checkpoint.mockRestore();
});

// hearsay-tools/squawk#1289: a clean close charges every attempted input it requeues unread, not
// only the session's latest attempt.
it('counts a failed wake delivery when a clean close requeues an earlier acknowledged batch the agent never read', async () => {
  const { record, group, input } = await openInputRun();
  f.store.commitWait(record.id, makeTimerWait());
  const deliver = async (text: string) => {
    const entry = input(text);
    f.store.commitAgentInputs(record.id, [...(f.store.getRun(record.id)?.agentInputs ?? []), entry]);
    f.manager.deliverConversationInput(record.id);
    const flight = group.agentInputFlight!;
    expect(flight.inputIds).toEqual([entry.id]);
    await flight.settled;
    return entry;
  };
  const first = await deliver('first batch, never read');
  const second = await deliver('second batch, read');
  reportConsumed([second.id]);
  expect([...group.unreadInputIds!]).toEqual([first.id]);
  // Without a charge the owed batch reopens the run at once, and its delivery clears any count.
  let charged = 0;
  const watch = () => { charged = Math.max(charged, f.store.getRun(record.id)?.waitDeliveryFailures ?? 0); };
  f.store.on('run', watch);
  try {
    closeWire();
    await waitForProduct(f.manager, f.store, () => charged > 0 || openedGroups.length > 1);
  } finally { f.store.off('run', watch); }
  expect(charged).toBe(1);
  expect(f.store.getRun(record.id)?.agentInputs?.find(entry => entry.id === first.id)?.deliveredAt).toBeUndefined();
});
