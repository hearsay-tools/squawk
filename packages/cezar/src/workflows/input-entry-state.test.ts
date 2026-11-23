import '../built-in-wait-kinds.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import { randomUUID } from 'node:crypto';
import { onTestFinished, expect, it, vi } from 'vitest';
import { InboxClaims } from './run/inbox-claims.ts';
import { inputDeliveryModule } from './run/input-delivery-module.testkit.ts';
import type { InputGroup } from './run/input-delivery.ts';

// The run's input state through `InputDelivery`, the receipt functions and `InboxClaims`, over a
// real store. How a fresh run, a Continue and restart recovery construct that state, and what a
// closing session does to it, stay on the engine in `input-entry-state-engine.test.ts`.

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const policy = { mode: 'steer' as const, consumption: 'observable' as const, acknowledgement: 'response' as const, humanInputAtTurnEnd: 'never-held' as const, via: 'entry-state fixture' };

function openInputRun() {
  const f = inputDeliveryModule(policy);
  expect(f.group.inputDelivery).toEqual(policy);
  return f;
}

it('clears retired markers before the ACK checkpoint even when that checkpoint throws', async () => {
  const f = openInputRun();
  const { group } = f;
  const message = f.input('work after the opening');
  const ack = deferred<void>();
  f.wire.ack = () => ack.promise;
  f.store.commitAgentInputs(f.runId, [message]);
  f.delivery.deliverConversationInput(f.runId);
  const flight = group.agentInputFlight!;
  expect(flight.settled).toBeInstanceOf(Promise);
  f.receiptEvent({ type: 'input-unconsumed', inputIds: [message.id] });
  expect(group.retiredInFlight?.has(message.id)).toBe(true);
  const checkpoint = vi.spyOn(f.store, 'commitOutcome').mockImplementationOnce(() => {
    expect(group.retiredInFlight?.has(message.id)).toBe(false);
    throw new Error('refused ACK checkpoint');
  });
  ack.resolve();
  await flight.settled;
  expect(checkpoint).toHaveBeenCalled();
  expect(group.retiredInFlight?.has(message.id)).toBe(false);
  expect(group.agentInputError).toContain('agent input delivery checkpoint failed: refused ACK checkpoint');
  checkpoint.mockRestore();
});

// The turn settler arms the held-input timer at a turn end when the session holds human input
// (`run/turn-settler.test.ts`); here the timer is armed as it does.
it('arms the held-input timer at turn end and clears it before publishing content', () => {
  const f = openInputRun();
  const { group } = f;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    f.wire.holds = true;
    f.turnEnd();
    f.delivery.armHeldHumanInputTimer(f.runId, f.state);
    const held = group.heldHumanInputTimer;
    expect(held).toBeDefined();
    expect(group.heldHumanInputSince).toBeDefined();
    const clock = group.heldHumanInputSince;
    const clear = clearTimeout;
    let observed = false;
    const spy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(handle => {
      if (handle === held) {
        observed = true;
        expect(group.heldHumanInputSince).toBe(clock);
        expect(f.store.eventLog.readEvents(f.runId).some(event => event.type === 'text' && event.text === 'Real activity')).toBe(false);
      }
      clear(handle);
    });
    f.receiptEvent({ type: 'text', text: 'Real activity' });
    expect(observed).toBe(true);
    expect(group.heldHumanInputTimer).toBeUndefined();
    expect(group.heldHumanInputSince).toBeUndefined();
    expect(group.heldHumanInputExpired).toBeUndefined();
    expect(f.store.eventLog.readEvents(f.runId).some(event => event.type === 'text' && event.text === 'Real activity')).toBe(true);
    spy.mockRestore();
  } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
});

for (const readAt of ['before-ACK', 'after-ACK'] as const) {
  it(`keeps receipt views live when consumption arrives ${readAt}`, async () => {
    const f = openInputRun();
    const { group } = f;
    const message = f.input('read this message');
    const ack = deferred<void>();
    f.wire.ack = () => ack.promise;
    const unread = group.unreadInputIds!;
    const early = group.consumedBeforeAck!;
    f.store.commitAgentInputs(f.runId, [message]);
    f.delivery.deliverConversationInput(f.runId);
    const flight = group.agentInputFlight!;
    if (readAt === 'before-ACK') {
      f.consumed([message.id]);
      expect(early.has(message.id)).toBe(true);
      expect(f.store.getRun(f.runId)?.agentInputs?.[0]?.consumedAt).toBeUndefined();
    }
    ack.resolve(); await flight.settled;
    if (readAt === 'after-ACK') {
      expect(unread.has(message.id)).toBe(true);
      expect(f.store.getRun(f.runId)?.agentInputs?.[0]?.awaitingRead).toBe(true);
      f.consumed([message.id]);
    }
    expect(group.unreadInputIds).toBe(unread);
    expect(group.consumedBeforeAck).toBe(early);
    expect(unread.has(message.id)).toBe(false);
    expect(early.has(message.id)).toBe(false);
    expect(f.store.getRun(f.runId)?.agentInputs?.[0]?.consumedAt).toBeDefined();
  });
}

it('keeps unread receipt views unchanged when the requeue checkpoint fails', async () => {
  const f = openInputRun();
  const { group } = f;
  const message = f.input('still awaiting a read');
  f.store.commitAgentInputs(f.runId, [message]);
  f.delivery.deliverConversationInput(f.runId);
  await group.agentInputFlight?.settled;
  const unread = group.unreadInputIds!;
  expect(unread.has(message.id)).toBe(true);
  const checkpoint = vi.spyOn(f.store, 'commitOutcome').mockImplementationOnce(() => { throw new Error('requeue disk fault'); });
  f.receiptEvent({ type: 'input-unconsumed', inputIds: [message.id] });
  expect(checkpoint).toHaveBeenCalled();
  expect(group.agentInputError).toBe('agent input requeue checkpoint failed: requeue disk fault');
  expect(unread.has(message.id)).toBe(true);
  expect(f.store.getRun(f.runId)?.agentInputs?.[0]?.deliveredAt).toBeDefined();
  checkpoint.mockRestore();
});

// The turn settler arms the unread-input timer at the turn end that tried the input
// (`run/turn-settler.test.ts`); here the timer is armed as it does.
it('retries accepted unread input once before leaving its receipt unconfirmed', async () => {
  const f = openInputRun();
  const { group } = f;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const message = f.input('accepted but never read');
    const unread = group.unreadInputIds!;
    f.store.commitAgentInputs(f.runId, [message]);
    f.delivery.deliverConversationInput(f.runId);
    await group.agentInputFlight?.settled;
    f.turnEnd();
    f.delivery.armUnreadInputTimer(f.runId, f.state);
    expect(group.unreadInputTimer).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(group.unreadRetried?.has(message.id)).toBe(true);
    expect(unread.has(message.id)).toBe(true);
    expect(group.unreadInputTimer).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(group.unreadInputIds).toBe(unread);
    expect(unread.has(message.id)).toBe(false);
    const receipt = f.receipt(message.id);
    expect(receipt?.deliveredAt).toBeDefined();
    expect(receipt?.awaitingRead).toBeUndefined();
    expect(receipt?.consumedAt).toBeUndefined();
    expect(f.store.eventLog.readEvents(f.runId).some(event => event.type === 'note' && String(event.message).includes('did not confirm'))).toBe(true);
  } finally { vi.useRealTimers(); }
});

/** `InboxClaims` wired to the module's delivery, as `run/compose.ts` wires it. */
function inboxClaims(f: ReturnType<typeof openInputRun>): InboxClaims {
  const claims: InboxClaims = new InboxClaims(f.context, {
    activeGet: id => (id === f.runId ? f.state : undefined), executionBlockedByRootFinish: () => false, workerExecutionStopped: () => false,
    reconcileWorkerWaits: () => undefined, retireEmptyWake: () => undefined, releaseSlot: () => undefined,
    deliverConversationInput: id => f.delivery.deliverConversationInput(id),
    settleIdleBoundary: (id, state, session) => f.delivery.settleIdleBoundary(id, state, session),
    providerOwnsInboxInput: (id, inputId) => claims.providerOwnsInboxInput(id, inputId),
    canClaimInboxInput: (id, inputId) => claims.canClaimInboxInput(id, inputId),
    armInboxClaimExpiry: id => claims.armInboxClaimExpiry(id),
  });
  onTestFinished(() => claims.dispose());
  return claims;
}

it('acknowledges claimed inbox input without leaving a provider delivery or an owed wake', () => {
  const f = openInputRun();
  const group: InputGroup = f.group;
  const claims = inboxClaims(f);
  const message = { ...f.input('read through the inbox'), source: agentInputSchema.shape.source.enum.agent,
    conversation: { senderRunId: randomUUID(), recipientRunId: f.runId, kind: 'progress' as const } };
  f.store.commitAgentInputs(f.runId, [message]);
  const generation = randomUUID();
  const claim = claims.reserveInboxInputs(f.runId, generation, [message.id]);
  expect(claim).toBeDefined();
  expect(claims.acknowledgeInbox(f.runId, generation, claim!.receiptId)).toBe('acknowledged');
  const receipt = f.receipt(message.id);
  expect(receipt?.deliveredAt).toBeDefined();
  expect(receipt?.inboxClaim?.acknowledgedAt).toBe(receipt?.deliveredAt);
  expect(group.agentInputFlight).toBeUndefined();
  expect(group.unreadInputIds?.size).toBe(0);
  expect(claims.canClaimInboxInput(f.runId, message.id)).toBe(false);
});
