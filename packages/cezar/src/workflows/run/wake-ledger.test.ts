import '../../built-in-wait-kinds.testkit.ts';
import { describe, expect, it, vi } from 'vitest';
import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { makeHumanWait, makeTimerWait, WAIT_PHASE, WAIT_VIA } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import { owedWakeInputIds, owesWake } from './wake-ledger.ts';

// The native-question gate must also hold after recovery, when no session exists.
describe('wake precedence', () => {
  it('a resolved wait wakes before conversation reads', () => {
    const run = makeRunRecord({ waits: [makeTimerWait({ phase: WAIT_PHASE.resolved })] });
    const routedAnswer = vi.fn<Parameters<typeof owesWake>[1]['routedAnswer']>();
    const pendingConversationWakes = vi.fn<Parameters<typeof owesWake>[1]['pendingConversationWakes']>();
    expect(owesWake(run, { routedAnswer, pendingConversationWakes })).toBe(true);
    expect(routedAnswer).not.toHaveBeenCalled();
    expect(pendingConversationWakes).not.toHaveBeenCalled();
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
