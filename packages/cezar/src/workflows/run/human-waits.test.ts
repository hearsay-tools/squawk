import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { makeHumanWait, makeTimerWait, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/wait-factories.testkit';
import { WAIT_LIMIT } from '@open-mercato/cezar-contract/wait-limits';
import { unused } from '../unused.testkit.ts';
import { boundaryOrderFixture } from './boundary-order.testkit.ts';
import { WaitEngine } from './wait-engine.ts';
import { WaitRegistry } from './wait-registry.ts';
import { isQuestionPending, pendingQuestion } from './human-waits.ts';

// hearsay-tools/squawk#1293: whether a question is pending is read from the open human wait rows.
describe('isQuestionPending', () => {
  it('reads an open agent human wait, shown or not, as a pending question', () => {
    const shown = makeHumanWait({ askSeq: 4 });
    expect(pendingQuestion({ waits: [shown] })).toEqual(shown);
    expect(isQuestionPending({ waits: [makeHumanWait()] })).toBe(true);
  });

  it('reads no question when nothing is open, or only Squawk\'s own wait is', () => {
    expect(isQuestionPending(undefined)).toBe(false);
    expect(isQuestionPending({ waits: [] })).toBe(false);
    expect(isQuestionPending({ waits: [makeHumanWait({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.budget, askSeq: 2 })] })).toBe(false);
    expect(isQuestionPending({ waits: [makeTimerWait()] })).toBe(false);
  });

  it('skips the question whose answer is in flight, but not a later one', () => {
    const answered = makeHumanWait({ askSeq: 4 });
    expect(isQuestionPending({ waits: [answered] }, 4)).toBe(false);
    const next = makeHumanWait({ askSeq: 9 });
    expect(pendingQuestion({ waits: [answered, next] }, 4)).toEqual(next);
    const unshown = makeHumanWait();
    expect(pendingQuestion({ waits: [answered, unshown] }, 4)).toEqual(unshown);
  });
});

// hearsay-tools/squawk#1293: an alias reuses only a wait with its own owner.
describe('openHumanAlias owner-matched reuse', () => {
  const card = (question: string) => [{ header: 'Pick', question, options: [{ label: 'A' }, { label: 'B' }] }];
  const ask = (f: ReturnType<typeof boundaryOrderFixture>, question: string) =>
    f.store.eventLog.appendEvent(f.run.id, { type: 'ask.requested', requestId: randomUUID(), questions: card(question) }).seq;

  it('an agent question never inherits a Squawk wait whose withdrawal was refused', () => {
    const f = boundaryOrderFixture();
    const fallbackSeq = ask(f, 'Squawk fallback?');
    const fallback = makeHumanWait({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'], askSeq: fallbackSeq });
    f.store.commitWait(f.run.id, fallback);
    vi.spyOn(f.waitEngine, 'cancel').mockReturnValue([]);
    const nativeSeq = ask(f, 'Native question?');
    const wait = f.humanWaits.openHumanAlias(f.run.id, f.state, WAIT_VIA['native-ask'], { questions: card('Native question?') })!;
    expect(wait).toMatchObject({ source: WAIT_SOURCE.agent });
    expect(wait.id).not.toBe(fallback.id);
    f.humanWaits.markHumanWaitSurfaced(f.run.id, wait);
    expect(f.store.commitOutcome(f.run.id, { kind: 'answered', askSeq: fallbackSeq }).answered).toEqual([fallback.id]);
    expect(f.store.getRun(f.run.id)!.waits).toMatchObject([{ id: wait.id, kind: WAIT_KIND.human, phase: WAIT_PHASE.open, askSeq: nativeSeq }]);
  });

  it('a Squawk alias reuses Squawk\'s wait and never an agent question', () => {
    const f = boundaryOrderFixture();
    const budget = makeHumanWait({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.budget, askSeq: 1 });
    f.store.commitWait(f.run.id, budget);
    expect(f.humanWaits.openHumanAlias(f.run.id, f.state, WAIT_VIA.budget)?.id).toBe(budget.id);
    const f2 = boundaryOrderFixture();
    const question = makeHumanWait({ askSeq: ask(f2, 'Agent question?') });
    f2.store.commitWait(f2.run.id, question);
    const opened = f2.humanWaits.openHumanAlias(f2.run.id, f2.state, WAIT_VIA.budget)!;
    expect(opened).toMatchObject({ source: WAIT_SOURCE.cezar });
    expect(opened.id).not.toBe(question.id);
  });
});

// hearsay-tools/squawk#1293: a routed answer reopens a worker through a continuation that keeps the
// answered question's wait open until its turn ends. At the wait limit, the agent's next question in
// that turn takes the answered wait's slot, so it still gets its own wait.
describe('the answered question\'s wait yields its slot at the wait limit', () => {
  const card = (question: string) => [{ header: 'Pick', question, options: [{ label: 'A' }, { label: 'B' }] }];
  function answeringAtLimit() {
    const f = boundaryOrderFixture();
    const ask = (question: string) => f.store.eventLog.appendEvent(f.run.id, { type: 'ask.requested', requestId: randomUUID(), questions: card(question) }).seq;
    const answeredSeq = ask('Answered?');
    const answered = makeHumanWait({ askSeq: answeredSeq });
    f.store.commitWait(f.run.id, answered);
    for (let n = 1; n < WAIT_LIMIT; n++) f.store.commitWait(f.run.id, makeTimerWait());
    f.state.inputState.answerOpeningAsk(answeredSeq);
    expect(f.waitEngine.hasRoom(f.store.getRun(f.run.id)!)).toBe(false);
    const settled = () => f.store.getRun(f.run.id)?.lastWaits?.find(wait => wait.id === answered.id);
    const humanOpen = () => (f.store.getRun(f.run.id)?.waits ?? []).filter(wait => wait.kind === WAIT_KIND.human);
    return { f, ask, answered, settled, humanOpen };
  }

  it('a native question opens its own wait in place of the answered one', () => {
    const { f, ask, settled, humanOpen } = answeringAtLimit();
    const nativeSeq = ask('Native question?');
    const wait = f.humanWaits.openHumanAlias(f.run.id, f.state, WAIT_VIA['native-ask'], { questions: card('Native question?') });
    expect(wait).toMatchObject({ source: WAIT_SOURCE.agent });
    f.humanWaits.markHumanWaitSurfaced(f.run.id, wait!);
    expect(settled()).toMatchObject({ phase: WAIT_PHASE.delivered });
    expect(humanOpen()).toMatchObject([{ id: wait!.id, askSeq: nativeSeq }]);
  });

  it('a cezar_ask registers its own wait in place of the answered one', async () => {
    const { f, settled, humanOpen } = answeringAtLimit();
    f.state.liveSession.beginCiGeneration('generation');
    // A mid-turn registration parks nothing: the turn has not reached its boundary.
    const waitEngine = new WaitEngine(f.context, unused<ConstructorParameters<typeof WaitEngine>[1]>('engine', {
      withdrawSquawkHumanWaits: id => f.humanWaits.withdrawSquawkHumanWaits(id), isParked: () => false,
    }), 40);
    const registry = new WaitRegistry(f.context, unused<ConstructorParameters<typeof WaitRegistry>[1]>('registry', {
      waitEngine, active: id => f.active.get(id), workerExecutionStopped: () => false,
      executionBlockedByRootFinish: () => false, countAutomaticWakes: () => 0,
    }), 40);
    const wait = await registry.registerAsk(f.run.id, { context: 'A choice.', questions: card('Portable question?') }, 'generation');
    expect(settled()).toMatchObject({ phase: WAIT_PHASE.delivered });
    expect(humanOpen()).toMatchObject([{ id: wait.id, source: WAIT_SOURCE.agent }]);
  });
});
