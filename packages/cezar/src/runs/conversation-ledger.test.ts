import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestOutcomeSchema } from '@open-mercato/cezar-contract/conversations';
import type { ConversationMessage, ConversationState, RequestOutcome, RunRecord } from '@open-mercato/cezar-contract';
import { acceptedRequest, StoredConversationLedger, type ConversationArchiveReads } from './conversation-ledger.ts';

const message = (id: string, senderRunId: string, recipientRunId: string, createdAt: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ id, senderRunId, recipientRunId, kind: 'request', text: id, createdAt, requestHash: id, state: 'accepted', ...extra });
const root = (id: string, conversation?: ConversationState): RunRecord =>
  ({ id, delegation: { role: 'root', receipts: [], ...(conversation ? { conversation } : {}) } }) as unknown as RunRecord;
const ledgerOver = (...runs: RunRecord[]) => new StoredConversationLedger(id => runs.find(run => run.id === id));

describe('StoredConversationLedger', () => {
  beforeEach(() => { vi.useFakeTimers({ now: Date.parse('2026-11-24T12:00:00.000Z') }); });
  afterEach(() => { vi.useRealTimers(); });
  const settled: RequestOutcome = { requestId: 'm1', status: 'timed-out', observedAt: '2026-11-24T10:05:00.000Z' };
  const state: ConversationState = {
    messages: [message('m1', 'w', 'p', '2026-11-24T10:00:00.000Z'), message('m2', 'p', 'w', '2026-11-24T10:01:00.000Z', { kind: 'progress' })],
    outcomes: [settled],
  };

  it('finds a message and an outcome by ID in the root row, and nothing elsewhere', () => {
    const worker = { id: 'w', delegation: { role: 'worker', parentRunId: 'p' } } as unknown as RunRecord;
    const ledger = ledgerOver(root('p', state), worker);
    expect(ledger.findMessage('p', 'm2')).toBe(state.messages[1]);
    expect(ledger.findOutcome('p', 'm1')).toBe(settled);
    expect(ledger.findMessage('p', 'missing')).toBeUndefined();
    expect(ledger.findOutcome('p', 'm2')).toBeUndefined();
    // A worker holds no ledger, and an unknown run has none.
    expect(ledger.findMessage('w', 'm1')).toBeUndefined();
    expect(ledger.findOutcome('gone', 'm1')).toBeUndefined();
    expect(ledgerOver(root('p')).findMessage('p', 'm1')).toBeUndefined();
  });

  it('keeps only an accepted request', () => {
    expect(acceptedRequest(state.messages[0])).toBe(state.messages[0]);
    expect(acceptedRequest(state.messages[1])).toBeUndefined();
    expect(acceptedRequest({ ...state.messages[0]!, state: 'late' })).toBeUndefined();
    expect(acceptedRequest(undefined)).toBeUndefined();
  });

  it('replaces the request outcome in place, or adds one, without changing the given state', () => {
    const ledger = ledgerOver(root('p', state));
    const late: RequestOutcome = { requestId: 'm1', status: 'replied-late', observedAt: '2026-11-24T10:06:00.000Z', replyId: 'r1' };
    const amended = ledger.amendOutcome('p', state, late);
    expect(amended.outcomes).toEqual([late]);
    expect(amended.messages).toBe(state.messages);
    expect(state.outcomes).toEqual([settled]);
    const added: RequestOutcome = { requestId: 'm3', status: requestOutcomeSchema.shape.status.enum.cancelled, observedAt: '2026-11-24T10:07:00.000Z' };
    expect(ledger.amendOutcome('p', state, added).outcomes).toEqual([settled, added]);
  });

  it('pages one pair across ledgers newest first, with outcomes and an older flag', () => {
    const a = root('a', { messages: [
      message('a1', 'a', 'b', '2026-11-24T10:00:00.000Z', { relationship: 'peer' }),
      message('a2', 'a', 'c', '2026-11-24T10:01:00.000Z', { relationship: 'peer' }),
      message('a3', 'a', 'b', '2026-11-24T10:03:00.000Z', { relationship: 'peer' }),
    ], outcomes: [{ requestId: 'a1', status: 'replied', observedAt: '2026-11-24T10:02:00.000Z', replyId: 'b1' }] });
    const b = root('b', { messages: [message('b1', 'b', 'a', '2026-11-24T10:02:00.000Z', { relationship: 'peer', kind: 'reply', requestId: 'a1' })], outcomes: [] });
    const ledger = ledgerOver(a, b);
    const all = ledger.page(['a', 'b'], ['a', 'b'], undefined, 10);
    expect(all.messages.map(entry => entry.id)).toEqual(['a1', 'b1', 'a3']);
    expect(all.outcomes.map(entry => entry.requestId)).toEqual(['a1']);
    expect(all.older).toBe(false);
    const newest = ledger.page(['a', 'b'], ['b', 'a'], undefined, 2);
    expect(newest.messages.map(entry => entry.id)).toEqual(['b1', 'a3']);
    expect(newest.outcomes).toEqual([]);
    expect(newest.older).toBe(true);
    const older = ledger.page(['a', 'b'], ['a', 'b'], newest.messages[0], 2);
    expect(older.messages.map(entry => entry.id)).toEqual(['a1']);
    expect(older.older).toBe(false);
    expect(ledger.page(['a', 'gone'], ['a', 'c'], undefined, 10).messages.map(entry => entry.id)).toEqual(['a2']);
  });

  it('reports a peer exchange from either ledger, and ignores family messages', () => {
    const a = root('a', { messages: [message('a1', 'a', 'b', '2026-11-24T10:00:00.000Z', { relationship: 'peer' })], outcomes: [] });
    const c = root('c', { messages: [message('c1', 'c', 'w', '2026-11-24T10:00:00.000Z')], outcomes: [] });
    const ledger = ledgerOver(a, root('b'), c);
    expect(ledger.peerExchanged('a', 'b')).toBe(true);
    expect(ledger.peerExchanged('b', 'a')).toBe(true);
    expect(ledger.peerExchanged('a', 'c')).toBe(false);
    expect(ledger.peerExchanged('c', 'w')).toBe(false);
    expect(ledger.peerExchanged('gone', 'a')).toBe(false);
  });

  it('answers from the archive after the row: by ID, in merged pages exactly once, and for peer exchanges', () => {
    const archived = [
      { message: message('x1', 'p', 'w', '2026-11-24T09:00:00.000Z'), outcome: { requestId: 'x1', status: 'timed-out', observedAt: '2026-11-24T09:10:00.000Z' } as RequestOutcome },
      { message: message('x2', 'w', 'p', '2026-11-24T09:01:00.000Z', { kind: 'progress' }) },
      { message: message('x3', 'p', 'q', '2026-11-24T09:02:00.000Z', { kind: 'progress', relationship: 'peer' }) },
    ];
    const between = (entry: (typeof archived)[number], pair: readonly [string, string]) => [entry.message.senderRunId, entry.message.recipientRunId].sort().join() === [...pair].sort().join();
    const archive: ConversationArchiveReads = {
      find: (rootId, id) => rootId === 'p' ? archived.find(entry => entry.message.id === id) : undefined,
      page: (rootIds, pair, before, limit) => archived.filter(entry => rootIds.includes('p') && between(entry, pair) &&
        (!before || entry.message.createdAt < before.createdAt)).slice(-limit),
      peerExchanged: (a, b) => [a, b].sort().join() === 'p,q',
      sentSince: (rootId, sender, recipient, since) => rootId === 'p' && archived.some(entry =>
        entry.message.senderRunId === sender && entry.message.recipientRunId === recipient && entry.message.createdAt >= since),
    };
    // A late reply amended the archived x1 in the row.
    const late: RequestOutcome = { requestId: 'x1', status: 'replied-late', observedAt: '2026-11-24T10:30:00.000Z', replyId: 'm2' };
    const ledger = new StoredConversationLedger(id => [root('p', { ...state, outcomes: [settled, late] })].find(run => run.id === id), () => archive);
    expect(ledger.findMessage('p', 'm1')).toBe(state.messages[0]);
    expect(ledger.findMessage('p', 'x2')).toBe(archived[1]!.message);
    expect(ledger.findOutcome('p', 'x1')).toBe(late);
    expect(ledger.findMessage('w', 'x2')).toBeUndefined();
    const seen: string[] = [];
    let before: { createdAt: string; id: string } | undefined;
    for (;;) {
      const page = ledger.page(['p'], ['p', 'w'], before, 2);
      seen.unshift(...page.messages.map(entry => entry.id));
      if (page.messages.some(entry => entry.id === 'x1')) expect(page.outcomes).toContainEqual(late);
      if (!page.older) break;
      before = page.messages[0];
    }
    expect(seen).toEqual(['x1', 'x2', 'm1', 'm2']);
    expect(ledger.peerExchanged('q', 'p')).toBe(true);
    expect(ledger.peerExchanged('w', 'p')).toBe(false);
    // A message since a time: the row's (m2 p->w at 10:01), else the archive's (x3 p->q at 09:02).
    expect(ledger.sentSince('p', 'p', 'w', '2026-11-24T10:01:00.000Z')).toBe(true);
    expect(ledger.sentSince('p', 'w', 'p', '2026-11-24T10:00:00.001Z')).toBe(false);
    expect(ledger.sentSince('p', 'p', 'q', '2026-11-24T09:02:00.000Z')).toBe(true);
    expect(ledger.sentSince('p', 'p', 'q', '2026-11-24T09:02:00.001Z')).toBe(false);
  });
});
