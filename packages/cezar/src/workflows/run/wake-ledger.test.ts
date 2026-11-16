import { describe, expect, it, vi } from 'vitest';
import { makeHumanWait, makeRunRecord, makeTimerWait, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { owedWakeInputIds, owesWake } from './wake-ledger.ts';

// The native-question gate must also hold after recovery, when no session exists.
describe('wake precedence', () => {
  it('a pending native question blocks resolved waits and messages until its routed answer arrives', () => {
    const run = makeRunRecord({ waits: [
      makeHumanWait({ via: WAIT_VIA['native-ask'] }),
      makeTimerWait({ phase: WAIT_PHASE.resolved }),
    ] });
    const routedAnswer = vi.fn<Parameters<typeof owesWake>[1]['routedAnswer']>().mockReturnValue(undefined);
    const pendingConversationWakes = vi.fn<Parameters<typeof owesWake>[1]['pendingConversationWakes']>();
    expect(owesWake(run, { routedAnswer, pendingConversationWakes })).toBe(false);
    expect(pendingConversationWakes).not.toHaveBeenCalled();
    routedAnswer.mockReturnValue({ id: 'answer', parentRunId: run.id, source: agentInputSchema.shape.source.enum.agent, text: 'Continue', createdAt: '2026-10-28T00:00:00Z' });
    expect(owesWake(run, { routedAnswer, pendingConversationWakes })).toBe(true);
    expect(pendingConversationWakes).not.toHaveBeenCalled();
  });

  it('a resolved wait wakes before conversation reads', () => {
    const run = makeRunRecord({ waits: [makeTimerWait({ phase: WAIT_PHASE.resolved })] });
    const routedAnswer = vi.fn<Parameters<typeof owesWake>[1]['routedAnswer']>();
    const pendingConversationWakes = vi.fn<Parameters<typeof owesWake>[1]['pendingConversationWakes']>();
    expect(owesWake(run, { routedAnswer, pendingConversationWakes })).toBe(true);
    expect(routedAnswer).not.toHaveBeenCalled();
    expect(pendingConversationWakes).not.toHaveBeenCalled();
  });

  it('with no pending native question or resolved wait, messages decide the wake', () => {
    const run = makeRunRecord();
    const pendingConversationWakes = vi.fn<Parameters<typeof owesWake>[1]['pendingConversationWakes']>().mockReturnValue([]);
    const routedAnswer = vi.fn<Parameters<typeof owesWake>[1]['routedAnswer']>().mockReturnValue(undefined);
    expect(owesWake(run, { routedAnswer, pendingConversationWakes })).toBe(false);
    expect(pendingConversationWakes).toHaveBeenCalledWith(run, undefined);
    expect(pendingConversationWakes.mock.invocationCallOrder[0]).toBeLessThan(routedAnswer.mock.invocationCallOrder[0]!);
  });
});

// hearsay-tools/squawk#1289: a wake's opening attempt names the inputs `owesWake` counts.
describe('owedWakeInputIds', () => {
  const input = (id: string) => ({ id, parentRunId: 'run', source: agentInputSchema.shape.source.enum.agent, text: id, createdAt: '2026-10-28T00:00:00Z' });
  const timer = makeTimerWait({ phase: WAIT_PHASE.resolved });
  const cases = [
    { name: 'nothing owed', waits: [], messages: [], answer: undefined, ids: [] },
    { name: 'a resolved wait, a message and a routed answer', waits: [timer], messages: ['message'], answer: 'answer', ids: [timer.id, 'message', 'answer'] },
    { name: 'a routed answer alone', waits: [], messages: [], answer: 'answer', ids: ['answer'] },
    { name: 'a native question with its answer', waits: [makeHumanWait({ via: WAIT_VIA['native-ask'] }), timer], messages: ['message'], answer: 'answer', ids: ['answer'] },
    { name: 'a native question without an answer', waits: [makeHumanWait({ via: WAIT_VIA['native-ask'] }), timer], messages: ['message'], answer: undefined, ids: [] },
  ];
  it.each(cases)('lists what owesWake counts: $name', ({ waits, messages, answer, ids }) => {
    const run = makeRunRecord({ waits });
    const reads = { routedAnswer: () => answer === undefined ? undefined : input(answer), pendingConversationWakes: () => messages.map(input) };
    expect(owedWakeInputIds(run, reads)).toEqual(ids);
    expect(owesWake(run, reads)).toBe(ids.length > 0);
  });
});
