import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInput, ConversationMessage, ConversationState, RequestOutcome, RunRecord } from '@open-mercato/cezar-contract';
import { agentInputSchema } from '@open-mercato/cezar-contract/agent-input';
import { CONVERSATION_ARCHIVE_THRESHOLD, compactConversation, TIMED_OUT_ACTIVE_MS, type CompactionReads } from './conversation-compaction.ts';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const AGENT = agentInputSchema.shape.source.enum.agent;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
let next = 0;
const id = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
const message = (extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ id: id(), senderRunId: 'parent', recipientRunId: 'worker', kind: 'progress', text: 'text', createdAt: ago(MINUTE), requestHash: 'a'.repeat(64), state: 'accepted', ...extra });

/** A world of two runs whose transcripts show every projection unless `missing` names it. */
function world(options: { inputs?: Record<string, AgentInput[]>; missing?: string[]; routed?: Record<string, string>; archived?: ConversationMessage[]; gone?: string[] } = {}): CompactionReads {
  const runs = new Map<string, RunRecord>(['parent', 'worker'].filter(runId => !options.gone?.includes(runId))
    .map(runId => [runId, { id: runId, agentInputs: options.inputs?.[runId] ?? [] } as unknown as RunRecord]));
  return {
    now: NOW,
    peek: runId => runs.get(runId),
    hasProjection: (_runId, projectionId) => !options.missing?.includes(projectionId),
    routedAskOpen: (workerId, messageId) => options.routed?.[workerId] === messageId,
    archivedMessage: (_rootId, messageId) => options.archived?.find(entry => entry.id === messageId),
  };
}
/** `entries` after `padding` old settled progress messages, so the ledger reaches the threshold. */
const ledger = (entries: ConversationMessage[], outcomes: RequestOutcome[] = []): ConversationState =>
  ({ messages: [...Array.from({ length: CONVERSATION_ARCHIVE_THRESHOLD - entries.length }, () => message()), ...entries], outcomes });
const kept = (state: ConversationState, reads: CompactionReads) => compactConversation('parent', state, reads).state.messages.map(entry => entry.id);

describe('compactConversation (hearsay-tools/squawk#4192)', () => {
  // Compaction reads its clock from `reads.now`; the pinned clock keeps the fixture dates honest.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });
  afterEach(() => { vi.useRealTimers(); });
  it('leaves a ledger below the threshold alone, and archives every settled entry once it reaches it', () => {
    const below: ConversationState = { messages: Array.from({ length: CONVERSATION_ARCHIVE_THRESHOLD - 1 }, () => message()), outcomes: [] };
    expect(compactConversation('parent', below, world())).toEqual({ state: below });
    const full = ledger([]);
    const compacted = compactConversation('parent', full, world());
    expect(compacted.state).toEqual({ messages: [], outcomes: [] });
    expect(compacted.archive).toEqual({ rootId: 'parent', entries: full.messages.map(entry => ({ message: entry })), outcomes: [] });
  });

  it('keeps an entry newer than the activity window, one whose input is not delivered or not read, and one a transcript does not show yet', () => {
    const recent = message({ createdAt: ago(1_000) });
    const queued = message();
    const unread = message();
    const read = message();
    const unprojected = message();
    const inputs = { worker: [
      { id: queued.id, source: AGENT, text: 'x', createdAt: ago(MINUTE) },
      { id: unread.id, source: AGENT, text: 'x', createdAt: ago(MINUTE), deliveredAt: ago(MINUTE), awaitingRead: true },
      { id: read.id, source: AGENT, text: 'x', createdAt: ago(MINUTE), deliveredAt: ago(MINUTE), awaitingRead: true, consumedAt: ago(MINUTE) },
    ] as AgentInput[] };
    expect(kept(ledger([recent, queued, unread, read, unprojected]), world({ inputs, missing: [`conversation-message:${unprojected.id}:not-delivered`] })))
      .toEqual([recent.id, queued.id, unread.id, unprojected.id]);
    // A participant that is gone has no transcript to wait for.
    expect(kept(ledger([unprojected]), world({ missing: [`conversation-message:${unprojected.id}:not-delivered`], gone: ['parent', 'worker'] }))).toEqual([]);
  });

  it('never archives an open request or a routed question whose ask is still open', () => {
    const open = message({ kind: 'request', createdAt: ago(10 * TIMED_OUT_ACTIVE_MS) });
    const question = message({ kind: 'request', senderRunId: 'worker', recipientRunId: 'parent', question: { questions: [{ question: 'Which?', header: 'Pick' }] } });
    const answered: RequestOutcome = { requestId: question.id, status: 'replied', observedAt: ago(MINUTE) };
    const state = ledger([open, question], [answered]);
    expect(kept(state, world({ routed: { worker: question.id } }))).toEqual([open.id, question.id]);
    // Once its ask closes, the answered question leaves with its outcome.
    const compacted = compactConversation('parent', state, world());
    expect(compacted.state).toEqual({ messages: [open], outcomes: [] });
    expect(compacted.archive?.entries.at(-1)).toEqual({ message: question, outcome: answered });
  });

  it('archives a settled request with its outcome after the window, a timed-out one after 24 h, and keeps one whose reply is not delivered', () => {
    const replied = message({ kind: 'request' });
    const reply = message({ kind: 'reply', senderRunId: 'worker', recipientRunId: 'parent', requestId: replied.id });
    const timedOut = message({ kind: 'request' });
    const expired = message({ kind: 'request' });
    const waiting = message({ kind: 'request' });
    const outcomes: RequestOutcome[] = [
      { requestId: replied.id, status: 'replied', observedAt: ago(MINUTE), replyId: reply.id },
      { requestId: timedOut.id, status: 'timed-out', observedAt: ago(TIMED_OUT_ACTIVE_MS - MINUTE) },
      { requestId: expired.id, status: 'timed-out', observedAt: ago(TIMED_OUT_ACTIVE_MS) },
      { requestId: waiting.id, status: 'replied', observedAt: ago(MINUTE), replyId: 'pending-reply' },
    ];
    const inputs = { parent: [{ id: 'pending-reply', source: AGENT, text: 'x', createdAt: ago(MINUTE) }] as AgentInput[] };
    const compacted = compactConversation('parent', ledger([replied, reply, timedOut, expired, waiting], outcomes), world({ inputs }));
    expect(compacted.state).toEqual({ messages: [timedOut, waiting], outcomes: [outcomes[1], outcomes[3]] });
    expect(compacted.archive?.entries.slice(-3)).toEqual([{ message: replied, outcome: outcomes[0] }, { message: reply }, { message: expired, outcome: outcomes[2] }]);
    // An outcome the transcripts do not show yet keeps its request.
    expect(kept(ledger([replied], [outcomes[0]!]), world({ missing: [`request-outcome:${replied.id}`] }))).toEqual([replied.id]);
  });

  it('moves a late reply\'s outcome to its archived request once it is old enough and shown', () => {
    const request = message({ kind: 'request' });
    const late: RequestOutcome = { requestId: request.id, status: 'replied-late', observedAt: ago(MINUTE), replyId: id() };
    const fresh: RequestOutcome = { ...late, observedAt: ago(1_000) };
    const unknown: RequestOutcome = { ...late, requestId: id() };
    const compacted = compactConversation('parent', ledger([message({ createdAt: ago(1_000) })], [late, unknown]), world({ archived: [request] }));
    expect(compacted.state.outcomes).toEqual([unknown]);
    expect(compacted.archive?.outcomes).toEqual([late]);
    expect(compactConversation('parent', ledger([message({ createdAt: ago(1_000) })], [fresh]), world({ archived: [request] })).state.outcomes).toEqual([fresh]);
    expect(compactConversation('parent', ledger([message({ createdAt: ago(1_000) })], [late]),
      world({ archived: [request], missing: [`request-outcome:${request.id}:replied-late`] })).state.outcomes).toEqual([late]);
  });
});
