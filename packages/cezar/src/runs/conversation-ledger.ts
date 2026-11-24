import type { ConversationMessage, ConversationState, RequestOutcome, RunRecord } from '@open-mercato/cezar-contract';
import type { ConversationArchiveRows } from './conversation-archive.ts';
import { conversationOf } from './task-rights.ts';

/** A position in the merged history order (`byCreatedAtAndId`). */
export type ConversationCursor = { createdAt: string; id: string };

/** One page of a pair's history: the newest `limit` messages before the cursor, oldest first,
 *  their request outcomes, and whether older messages exist. */
export type ConversationPage = { messages: ConversationMessage[]; outcomes: RequestOutcome[]; older: boolean };

/**
 * The family conversation ledger, read by ID (hearsay-tools/squawk#4192). A caller that names a
 * message or a request — to retry, reply, follow up, cancel, wait or show an outcome — asks here,
 * never the row's arrays, so an entry stays findable wherever the store keeps it. Each read answers
 * from the root's row ledger, then from the archive the store keeps beside it (`conversation_archive`).
 * A caller that needs only what is still active (open requests, inbox slots, capacity) reads the row.
 */
export interface ConversationLedger {
  /** The message `id` in root `rootId`'s ledger, whatever its kind or state. */
  findMessage(rootId: string, id: string): ConversationMessage | undefined;
  /** The outcome of request `requestId` in root `rootId`'s ledger. */
  findOutcome(rootId: string, requestId: string): RequestOutcome | undefined;
  /** `state`, the active ledger of root `rootId`, with `outcome` in place of its request's earlier
   *  outcome, or added when it has none. The caller commits the result. */
  amendOutcome(rootId: string, state: ConversationState, outcome: RequestOutcome): ConversationState;
  /** The history between the two runs of `pair` across the ledgers of `rootIds`, merged in
   *  `(createdAt, id)` order. */
  page(rootIds: readonly string[], pair: readonly [string, string], before: ConversationCursor | undefined, limit: number): ConversationPage;
  /** Whether a peer message ever passed between runs `a` and `b`, in either one's ledger. */
  peerExchanged(a: string, b: string): boolean;
  /** Whether root `rootId`'s ledger holds a message from `senderRunId` to `recipientRunId` created
   *  at or after `since`. */
  sentSince(rootId: string, senderRunId: string, recipientRunId: string, since: string): boolean;
}

/** The merged history order: `createdAt`, then `id`, a total order a cursor can name. */
export function byCreatedAtAndId(a: ConversationCursor, b: ConversationCursor): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** `message` when it is an accepted request. */
export function acceptedRequest(message: ConversationMessage | undefined): ConversationMessage | undefined {
  return message?.kind === 'request' && message.state === 'accepted' ? message : undefined;
}

/** The archive reads the ledger answers after the row. */
export type ConversationArchiveReads = Pick<ConversationArchiveRows, 'find' | 'page' | 'peerExchanged' | 'sentSince'>;

/** The ledger as the store keeps it: each root's active entries in its row, the settled rest in
 *  `archive` (none for a store without a database). The row answers first. */
export class StoredConversationLedger implements ConversationLedger {
  constructor(private readonly lookup: (id: string) => RunRecord | undefined, private readonly archive: () => ConversationArchiveReads | undefined = () => undefined) {}

  private state(rootId: string): ConversationState | undefined {
    return conversationOf(this.lookup(rootId));
  }

  findMessage(rootId: string, id: string): ConversationMessage | undefined {
    return this.state(rootId)?.messages.find(message => message.id === id) ?? this.archive()?.find(rootId, id)?.message;
  }

  findOutcome(rootId: string, requestId: string): RequestOutcome | undefined {
    return this.state(rootId)?.outcomes.find(outcome => outcome.requestId === requestId) ?? this.archive()?.find(rootId, requestId)?.outcome;
  }

  /** An archived request's new outcome joins the row's outcomes; the next commit that compacts the
   *  ledger replaces the archived one with it. Until then the row's answers first. */
  amendOutcome(_rootId: string, state: ConversationState, outcome: RequestOutcome): ConversationState {
    const index = state.outcomes.findIndex(entry => entry.requestId === outcome.requestId);
    const outcomes = index < 0 ? [...state.outcomes, outcome] : state.outcomes.map((entry, at) => at === index ? outcome : entry);
    return { ...state, outcomes };
  }

  page(rootIds: readonly string[], pair: readonly [string, string], before: ConversationCursor | undefined, limit: number): ConversationPage {
    const [self, other] = pair;
    const between = (message: ConversationMessage) => (message.senderRunId === self && message.recipientRunId === other) ||
      (message.senderRunId === other && message.recipientRunId === self);
    const states = rootIds.flatMap(id => this.state(id) ?? []);
    const active = states.flatMap(state => state.messages.filter(between)).filter(message => !before || byCreatedAtAndId(message, before) < 0);
    const held = new Set(active.map(message => message.id));
    // The newest `limit + 1` archived messages decide the page and whether older ones exist.
    const archived = (this.archive()?.page(rootIds, pair, before, limit + 1) ?? []).filter(entry => !held.has(entry.message.id));
    const merged = [...active, ...archived.map(entry => entry.message)].sort(byCreatedAtAndId);
    const messages = merged.slice(-limit);
    const ids = new Set(messages.map(message => message.id));
    const outcomes = states.flatMap(state => state.outcomes.filter(outcome => ids.has(outcome.requestId)));
    const answered = new Set(outcomes.map(outcome => outcome.requestId));
    for (const entry of archived) if (entry.outcome && ids.has(entry.message.id) && !answered.has(entry.outcome.requestId)) outcomes.push(entry.outcome);
    return { messages, outcomes, older: merged.length > messages.length };
  }

  peerExchanged(a: string, b: string): boolean {
    const between = (message: ConversationMessage) => message.relationship === 'peer' &&
      [message.senderRunId, message.recipientRunId].includes(a) && [message.senderRunId, message.recipientRunId].includes(b);
    return [a, b].some(id => this.state(id)?.messages.some(between) ?? false) || (this.archive()?.peerExchanged(a, b) ?? false);
  }

  sentSince(rootId: string, senderRunId: string, recipientRunId: string, since: string): boolean {
    return (this.state(rootId)?.messages.some(message => message.senderRunId === senderRunId && message.recipientRunId === recipientRunId && message.createdAt >= since) ?? false) ||
      (this.archive()?.sentSince(rootId, senderRunId, recipientRunId, since) ?? false);
  }
}
