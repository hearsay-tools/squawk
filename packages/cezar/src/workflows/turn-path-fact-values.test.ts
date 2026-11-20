import { expect, it, vi } from 'vitest';
import type { InputDelivery } from '../core/agent-runner.ts';
import { createActiveRun } from './active-run.ts';
import { inputDeliveryModule } from './run/input-delivery-module.testkit.ts';
import { commitBundledDelivery } from './run/input-receipts.ts';
import type { RunModuleContext } from './run/types.ts';

// Shared parity rows run on one runner (docs/adr/0063-one-scenario-runner.md). These cells drive
// Squawk's input delivery with every declared value of the delivery facts, so a value that runner
// does not declare is still tested above the seam. `FACT_VALUE_TESTS` in
// `core/parity-classes.testkit.ts` names this file for those values. The session here behaves as
// each value says; the seam contract (S36–S44) holds each real runner to the values it declares.

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function openRun(delivery: InputDelivery) {
  const f = inputDeliveryModule(delivery);
  expect(f.group.inputDelivery).toEqual(delivery);
  return f;
}

const STEER = { mode: 'steer', consumption: 'observable', acknowledgement: 'response', humanInputAtTurnEnd: 'held-when-late', via: 'fact-values fixture' } as const;

// inputDelivery.consumption: an observable harness owes a read after its acknowledgement; an
// unobservable one is done at the acknowledgement.
for (const consumption of ['observable', 'unobservable'] as const) {
  it(`consumption '${consumption}' decides whether a delivered input still awaits its read`, async () => {
    const f = openRun({ ...STEER, consumption });
    const message = f.input('read this');
    const ack = deferred<void>();
    f.wire.ack = () => ack.promise;
    f.store.commitAgentInputs(f.runId, [message]);
    f.delivery.deliverConversationInput(f.runId);
    const flight = f.group.agentInputFlight!;
    f.consumed([message.id]);
    ack.resolve();
    await flight.settled;
    expect(f.receipt(message.id)?.deliveredAt).toBeDefined();
    if (consumption === 'observable') {
      expect(f.receipt(message.id)?.consumedAt).toBeDefined();
    } else {
      expect(f.receipt(message.id)?.awaitingRead).toBeUndefined();
      expect(f.receipt(message.id)?.consumedAt).toBeUndefined();
      expect(f.group.unreadInputIds?.size ?? 0).toBe(0);
    }
  });
}

// The same rule for messages bundled with a human answer: one commit, and a read is owed only
// where the harness reports reads.
for (const consumption of ['observable', 'unobservable'] as const) {
  it(`consumption '${consumption}' decides whether messages bundled with an answer await their read`, () => {
    const commitOutcome = vi.fn();
    const context = { store: { commitOutcome } } as unknown as RunModuleContext;
    const state = createActiveRun({ cwd: '/work', pendingHumanAsk: false, autonomous: false });
    state.inputState.declareDelivery({ ...STEER, consumption });
    expect(commitBundledDelivery(context, 'run-1', state, ['bundled-1'], [{ kind: 'answered' }])).toBeUndefined();
    const [, outcomes] = commitOutcome.mock.calls[0]!;
    expect(outcomes).toEqual([{ kind: 'answered' }, {
      kind: 'delivered', inputIds: ['bundled-1'], at: expect.any(String),
      ...(consumption === 'observable' ? { awaitingRead: true } : {}),
    }]);
    expect(state.inputState.bundledInputIds).toEqual(['bundled-1']);
  });
}

// inputDelivery.acknowledgement and inputDelivery.mode: Squawk reads neither value. It sees only
// when the session acknowledges a write: at once ('write') or after the native response
// ('response'). Input stays undelivered until then, across a turn end.
const ACKNOWLEDGEMENTS = [
  { mode: 'steer', acknowledgement: 'write', humanInputAtTurnEnd: 'held-when-late', afterTurnEnd: false },
  { mode: 'steer', acknowledgement: 'response', humanInputAtTurnEnd: 'held-when-late', afterTurnEnd: false },
  { mode: 'steer', acknowledgement: 'response', humanInputAtTurnEnd: 'held-when-late', afterTurnEnd: true },
] as const;
for (const { mode, acknowledgement, humanInputAtTurnEnd, afterTurnEnd } of ACKNOWLEDGEMENTS) {
  it(`mode '${mode}' with acknowledgement '${acknowledgement}' delivers an input only at its acknowledgement${afterTurnEnd ? ', after the turn ends' : ''}`, async () => {
    const f = openRun({ mode, consumption: 'observable', acknowledgement, humanInputAtTurnEnd, via: 'fact-values fixture' });
    const message = f.input('work for the next model call');
    const ack = deferred<void>();
    f.wire.ack = () => ack.promise;
    f.store.commitAgentInputs(f.runId, [message]);
    f.delivery.deliverConversationInput(f.runId);
    const flight = f.group.agentInputFlight!;
    expect(flight).toBeDefined();
    if (afterTurnEnd) f.turnEnd();
    expect(f.receipt(message.id)?.deliveredAt).toBeUndefined();
    expect(f.group.agentInputFlight).toBe(flight);
    ack.resolve();
    await flight.settled;
    expect(f.receipt(message.id)?.deliveredAt).toBeDefined();
    // The message's flight is over. A later flight carries no input: after a turn end with no
    // read owed, the run may send its own follow-up prompt.
    expect(f.group.agentInputFlight === flight).toBe(false);
    expect(f.group.agentInputFlight?.inputIds ?? []).not.toContain(message.id);
  });
}

// inputDelivery.humanInputAtTurnEnd: Squawk asks the session at turn end whether it still holds a
// human message. A 'never-held' harness never does; 'held-when-late' and 'always-held' can, and
// then the run keeps its session for the turn that message opens, under the held-input timer.
// The turn settler arms the timer at a turn end (`run/turn-settler.test.ts`); the timer asks the
// session itself.
for (const humanInputAtTurnEnd of ['never-held', 'held-when-late', 'always-held'] as const) {
  it(`humanInputAtTurnEnd '${humanInputAtTurnEnd}' decides whether a turn end keeps a held human message`, () => {
    const delivery: InputDelivery = { ...STEER, humanInputAtTurnEnd };
    const f = openRun(delivery);
    f.wire.holds = humanInputAtTurnEnd !== 'never-held';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      f.turnEnd();
      f.delivery.armHeldHumanInputTimer(f.runId, f.state);
      if (humanInputAtTurnEnd === 'never-held') {
        expect(f.group.heldHumanInputTimer).toBeUndefined();
      } else {
        expect(f.group.heldHumanInputTimer).toBeDefined();
        expect(f.group.heldHumanInputSince).toBeDefined();
      }
    } finally { vi.useRealTimers(); }
  });
}
