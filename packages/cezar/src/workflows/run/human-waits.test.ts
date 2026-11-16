import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { makeHumanWait, makeTimerWait, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { boundaryOrderFixture } from './boundary-order.testkit.ts';
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
    f.store.appendEvent(f.run.id, { type: 'ask.requested', requestId: randomUUID(), questions: card(question) }).seq;

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
