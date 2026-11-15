import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HumanWaitEntry, Wait } from '@open-mercato/cezar-contract/waits';
import { isQuestionPending, pendingQuestion } from './human-waits.ts';

function human(overrides: Partial<HumanWaitEntry> = {}): HumanWaitEntry {
  return { id: randomUUID(), kind: 'human', source: 'agent', via: 'cezar_ask', registeredAt: new Date(0).toISOString(), phase: 'open', turnId: 'turn-1', ...overrides };
}

// hearsay-tools/squawk#1293: whether a question is pending is read from the open human wait rows.
describe('isQuestionPending', () => {
  it('reads an open agent human wait, shown or not, as a pending question', () => {
    const shown = human({ askSeq: 4 });
    expect(pendingQuestion({ waits: [shown] })).toEqual(shown);
    expect(isQuestionPending({ waits: [human()] })).toBe(true);
  });

  it('reads no question when nothing is open, or only Squawk\'s own wait is', () => {
    expect(isQuestionPending(undefined)).toBe(false);
    expect(isQuestionPending({ waits: [] })).toBe(false);
    expect(isQuestionPending({ waits: [human({ source: 'cezar', via: 'budget', askSeq: 2 })] })).toBe(false);
    const timer = { id: randomUUID(), kind: 'timer', source: 'agent', via: 'cezar_wait', registeredAt: new Date(0).toISOString(),
      deadline: new Date(60_000).toISOString(), phase: 'open', turnId: 'turn-1' } as Wait;
    expect(isQuestionPending({ waits: [timer] })).toBe(false);
  });

  it('skips the question whose answer is in flight, but not a later one', () => {
    const answered = human({ askSeq: 4 });
    expect(isQuestionPending({ waits: [answered] }, 4)).toBe(false);
    const next = human({ askSeq: 9 });
    expect(pendingQuestion({ waits: [answered, next] }, 4)).toEqual(next);
    const unshown = human();
    expect(pendingQuestion({ waits: [answered, unshown] }, 4)).toEqual(unshown);
  });
});
