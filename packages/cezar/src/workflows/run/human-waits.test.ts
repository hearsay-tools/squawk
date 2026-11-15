import { describe, expect, it } from 'vitest';
import { makeHumanWait, makeTimerWait, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
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
