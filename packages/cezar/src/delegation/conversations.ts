import { productName } from '../home/display.ts';
import { createHash } from 'node:crypto';
import type { AgentInput, ConversationMessage, ConversationSendRequest, ConversationState, DelegationState, RequestOutcome } from '@open-mercato/cezar-contract';
import { deliveryReceipts } from '../runs/outcome-commit.ts';
import { ConversationIdInUseError, RunWriteRefusedError, type RunRecord, type RunStore } from '../runs/store.ts';
import { conversationOf, DEFAULT_GRANTS, familyRecordIdOf, familyRecordOf, finishing, historyDeleting, holdsOperation, messageRelation, receiptsOf, type Lookup } from '../runs/task-rights.ts';
import { DelegationPolicyError } from './policy.ts';
import { reservedReplies } from './questions.ts';

/**
 * A request settles by its two participants, read from the message itself: its sender closed or
 * finishing, or its recipient closed, destroyed or deleted. The run that stores the ledger decides
 * nothing: a request between two live workers stays open when the ledger's holder has ended.
 * First durable request settlement wins, with the defined late-reply timeout amendment handled
 * by send. Review is not completion for a worker, which its parent can resume; a peer recipient at
 * review settles `completed-without-reply` at once, because no peer can resume it, and a deleted
 * one settles `deleted` (spec 2026-10-27-task-communication-protocol § 5, § 7). Lookup only the
 * named sender/recipient runs.
 */
export function reconcileConversationState(root: RunRecord, lookup: (id: string) => RunRecord | undefined, now: string, isSettled: (run: RunRecord) => boolean,
  unreadable: (id: string) => boolean = () => false): ConversationState | undefined {
  const state = conversationOf(root);
  if (!state) return undefined;
  const outcomes = [...state.outcomes];
  for (const request of state.messages) {
    if (request.kind !== 'request' || request.state !== 'accepted' || outcomes.some(outcome => outcome.requestId === request.id)) continue;
    const recipient = lookup(request.recipientRunId);
    const status = request.relationship === 'peer' ? peerRecipientSettlement(recipient, isSettled, unreadable(request.recipientRunId)) : familyRecipientSettlement(root, request, recipient, isSettled);
    const closed = (run: RunRecord | undefined) => run && ['done', 'failed', 'cancelled'].includes(run.status) && isSettled(run);
    const sender = lookup(request.senderRunId);
    const humanFinished = finishing(sender);
    const settled = (humanFinished ? 'sender-closed' : status) ?? (closed(sender) ? 'sender-closed'
      : request.deadline && request.deadline <= now ? 'timed-out' : undefined);
    if (settled) outcomes.push({ requestId: request.id, status: settled, observedAt: now });
  }
  return outcomes.length === state.outcomes.length ? state : { ...state, outcomes };
}

/** A peer recipient settles the request when it is deleted, rests at `review` (no peer can resume
 *  it), or ends `done`, `failed` or `cancelled`. A row this store cannot decode is not a deleted
 *  one: its request stays open (hearsay-tools/cezarion#1990 review). */
function peerRecipientSettlement(recipient: RunRecord | undefined, isSettled: (run: RunRecord) => boolean, unreadable: boolean): RequestOutcome['status'] | undefined {
  if (!recipient) return unreadable ? undefined : 'deleted';
  if (!['review', 'done', 'failed', 'cancelled'].includes(recipient.status) || !isSettled(recipient)) return undefined;
  return recipient.status === 'review' || recipient.status === 'done' ? 'completed-without-reply' : recipient.status as 'failed' | 'cancelled';
}

/** A family recipient: a destroyed worker, or a closed one. Review is not completion: its parent can resume it. */
function familyRecipientSettlement(root: RunRecord, request: ConversationMessage, recipient: RunRecord | undefined, isSettled: (run: RunRecord) => boolean): RequestOutcome['status'] | undefined {
  const deletedRecipient = !recipient && receiptsOf(root).some(receipt => receipt.workerId === request.recipientRunId && receipt.deletion?.phase === 'complete');
  if (deletedRecipient || (recipient?.delegation?.role === 'worker' && recipient.delegation.destroy?.phase === 'complete')) return 'destroyed';
  if (!recipient || !['done', 'failed', 'cancelled'].includes(recipient.status) || !isSettled(recipient)) return undefined;
  // A worker's question ends with its parent like any request; it never moves to a human
  // (hearsay-tools/cezarion#2410).
  return recipient.status === 'done' ? 'completed-without-reply' : recipient.status as 'failed' | 'cancelled';
}

/** Repair observation only; replay never inserts agent inputs or starts execution. A ledger whose
 *  history is being deleted projects nothing: its events would recreate deleted transcripts
 *  (hearsay-tools/cezarion#1990 review). */
export function projectConversationEvents(store: import('../runs/store.ts').RunStore, root: RunRecord): void {
  const state = conversationOf(root);
  if (!state || historyDeleting(root)) return;
  const outcomes = new Map(state.outcomes.map(outcome => [outcome.requestId, outcome]));
  for (const message of state.messages) {
    for (const runId of [message.senderRunId, message.recipientRunId]) {
      if (!store.getRun(runId)) continue;
      try {
        projectDelivery(store, runId, message);
        projectOutcome(store, runId, outcomes.get(message.id));
      } catch (error) {
        // A peer read from `.ai/squawk/` stays unchanged; its own binary projects its transcript.
        if (!(error instanceof RunWriteRefusedError && error.ownership === 'fallback')) throw error;
      }
    }
  }
}

/** Project delivery steps for one participant, preserving their order and indexed IDs. */
function projectDelivery(store: RunStore, runId: string, message: ConversationMessage): void {
  // The run's indexed projection ids (open-mercato/cezar#880): appendEvent keeps them, so no transcript read.
  const ids = { has: (id: string) => store.hasProjection(runId, id) };
  const input = store.getRun(message.recipientRunId)?.agentInputs?.find(input => input.id === message.id);
  const delivery = input?.consumedAt ? 'consumed' : input?.deliveredAt ? 'delivered' : input ? 'queued' : 'not-delivered';
  // A read message was delivered first, even when both landed between two projections;
  // readers that predate `consumed` still see it delivered (hearsay-tools/cezarion#505).
  for (const step of delivery === 'consumed' ? ['delivered', 'consumed'] as const : [delivery] as const) {
    const projectionId = `conversation-message:${message.id}:${step}`;
    if (ids.has(projectionId)) continue;
    store.appendEvent(runId, { type: 'conversation-message', projectionId, message, delivery: step, ...deliveryReceipts(input, step) });
  }
}

/** A request's outcome on one participant's transcript, once; a late reply gets its own projection. */
function projectOutcome(store: Pick<import('../runs/store.ts').RunStore, 'appendEvent' | 'hasProjection'>, runId: string, outcome: RequestOutcome | undefined): void {
  if (!outcome) return;
  const projectionId = `request-outcome:${outcome.requestId}${outcome.status === 'replied-late' ? ':replied-late' : ''}`;
  if (!store.hasProjection(runId, projectionId)) store.appendEvent(runId, { type: 'request-outcome', projectionId, outcome });
}

/** The record that makes a run a root task: every worker operation, no receipts yet. */
export const rootDelegation = (): DelegationState => ({ role: 'root', permissions: [...DEFAULT_GRANTS.root.operate], receipts: [] });

const denyScope = (): never => { throw new DelegationPolicyError('denied_scope', 'Worker scope denied'); };

export type ResolvedPair = { sender: RunRecord; recipient: RunRecord } &
  ({ relationship: 'peer' } | { relationship: 'family'; relation: 'supervisor' | 'supervised'; root: RunRecord; worker: RunRecord });

/**
 * The relationship resolver (spec 2026-10-27-task-communication-protocol § 2): `peer` for two root
 * tasks of one project, `family` for a task and the worker it supervises, in either direction, and
 * `denied_scope` with one text for everything else. A family pair names its `root`, the run that
 * holds the family's ledger, and the direction: `supervised` when the sender supervises the
 * recipient. `send` asks for the live sender a new message needs.
 */
export function resolvePair(sender: RunRecord | undefined, recipient: RunRecord | undefined, getRun: Lookup, send: boolean): ResolvedPair {
  const lookup: Lookup = id => [sender, recipient].find(run => run?.id === id) ?? getRun(id);
  const relation = messageRelation(sender, recipient, lookup);
  if (!relation || !sender || !recipient) return denyScope();
  if (relation === 'peer') {
    if (send) assertLiveSender(sender);
    return { relationship: 'peer', sender, recipient };
  }
  const worker = relation === 'supervised' ? recipient : sender;
  const root = familyRecordOf(worker, lookup);
  if (!root) return denyScope();
  // A supervisor sends a new message under its `steer` grant.
  if (send && relation === 'supervised' && !holdsOperation(sender, 'steer')) denyScope();
  if (send) assertLiveSender(sender);
  return { relationship: 'family', relation, sender, recipient, root, worker };
}

/** A sender of a new message is live, not finishing and not being destroyed. */
function assertLiveSender(sender: RunRecord): void {
  if (!['running', 'waiting'].includes(sender.status) || finishing(sender) ||
    (sender.delegation?.role === 'worker' && sender.delegation.destroy)) throw new DelegationPolicyError('incompatible_state', 'Sender session is not active');
}

/** Why a send to a run that cannot take it now was not delivered, and the next step. */
export function notDeliveredInstruction(pair: ResolvedPair): string {
  const { recipient } = pair;
  if (recipient.delegation?.role === 'worker' && (recipient.status === 'cancelled' || recipient.stopping || recipient.delegation.destroy)) {
    return 'Not delivered: this worker was stopped or is being destroyed. Spawn a new worker for further work.';
  }
  if (pair.relationship === 'peer') return `Not delivered: task is ${recipient.stopping ? 'stopping' : finishing(recipient) ? 'finishing' : recipient.status}. Only its human can continue it.`;
  return pair.relation === 'supervised'
    ? `Not delivered: worker is ${recipient.status}. To resume it with a new instruction, run worker resume ${recipient.id} "<instruction>" --id <new-message-UUID>; use a new message ID. Retrying this rejected ID will not deliver it.`
    : `Not delivered: parent is ${recipient.status}. A worker cannot resume its parent; the parent must be continued by its owner.`;
}

/** The ledger's 1,024 messages, where every open request holds room for its reply and a new
 *  request needs room for its own; its 32 open requests; and 32 inbox slots per run, which hold its
 *  undelivered inputs and one slot for each open peer request it sent (`inboxSlotsUsed`). A new
 *  peer request needs a free slot in its sender's inbox; its reply then spends that slot, so it is
 *  always admitted and no inbox passes 32. An answer to a worker question passes the inbox bound,
 *  as it always did (hearsay-tools/cezarion#505). */
export function assertConversationCapacity(state: ConversationState, pair: { relationship: 'family' | 'peer'; sender: RunRecord; recipient: RunRecord }, kind: ConversationSendRequest['kind'],
  enqueue: boolean, replying: boolean, answering: boolean): void {
  const reservedMessages = reservedReplies(state) - (replying ? 1 : 0) + (enqueue && kind === 'request' ? 1 : 0);
  const openRequests = () => state.messages.filter(message => message.kind === 'request' && message.state === 'accepted' && !state.outcomes.some(outcome => outcome.requestId === message.id)).length;
  const peer = pair.relationship === 'peer';
  const inboxFull = enqueue && !answering && !(peer && replying) && inboxSlotsUsed(pair.recipient) >= 32;
  if (state.messages.length + reservedMessages >= 1024 || (enqueue && kind === 'request' && openRequests() >= 32) || inboxFull ||
    (enqueue && peer && kind === 'request' && inboxSlotsUsed(pair.sender) >= 32)) throw new DelegationPolicyError('capacity_limit', 'Conversation capacity limit reached');
}

/** A run's inbox slots in use: its undelivered inputs, and one for each open peer request it sent,
 *  which its reply will fill. */
export function inboxSlotsUsed(run: RunRecord): number {
  const undelivered = (run.agentInputs ?? []).filter(input => !input.deliveredAt).length;
  const state = conversationOf(run);
  const reserved = state?.messages.filter(message => message.relationship === 'peer' && message.kind === 'request' && message.state === 'accepted' &&
    message.senderRunId === run.id && !state.outcomes.some(outcome => outcome.requestId === message.id)).length ?? 0;
  return undelivered + reserved;
}

/** A reply settles its request, or amends a deadline expiry to `replied-late`. Cancellation,
 *  lifecycle settlement and an earlier reply still win; the request never becomes pending again. */
export function replyOutcomes(state: ConversationState, request: ConversationSendRequest, settled: RequestOutcome | undefined, now: string): RequestOutcome[] {
  const outcomes = [...state.outcomes];
  if (request.kind !== 'reply' || (settled && settled.status !== 'timed-out')) return outcomes;
  const outcome = { requestId: request.requestId!, status: settled ? 'replied-late' as const : 'replied' as const, observedAt: now, replyId: request.id };
  if (settled) outcomes[outcomes.indexOf(settled)] = outcome;
  else outcomes.push(outcome);
  return outcomes;
}

/** One write for the message, its ledger and the recipient's input; a message ID already in use
 *  there refuses the whole write. A peer that has not opened a session yet becomes a root task
 *  with its first message (spec § 2). */
export function commitAccepted(store: RunStore, ledgerId: string, next: ConversationState, input: AgentInput | undefined, provision: boolean): void {
  const message = next.messages.at(-1)!;
  const delivery = input ? { recipientRunId: message.recipientRunId, input, ...(provision ? { recipientDelegation: rootDelegation() } : {}) } : undefined;
  try { store.commitConversation(ledgerId, next, delivery, { id: message.id, senderRunId: message.senderRunId, recipientRunId: message.recipientRunId }); }
  catch (error) {
    if (error instanceof ConversationIdInUseError) throw new DelegationPolicyError('invalid_input', error.message);
    // Another Squawk process controls the recipient (a headless run beside the cockpit): nothing is written.
    if (error instanceof RunWriteRefusedError && error.ownership === 'fallback') throw new DelegationPolicyError('incompatible_state', `Not delivered: ${error.message}`);
    if (error instanceof RunWriteRefusedError) throw new DelegationPolicyError('incompatible_state', `Not delivered: run ${error.runId} is controlled by another ${productName('cezar')} process. Messages reach only tasks this ${productName('cezar')} process runs.`);
    throw error;
  }
}

export type InboxEntry = { message: ConversationMessage; outcome?: RequestOutcome | undefined };

/** The accepted message an input carries, as its ledger holds it, with its request's outcome. */
export function inboxEntryIn(state: ConversationState, input: AgentInput, recipientId: string): InboxEntry | undefined {
  const message = state.messages.find(entry => entry.id === input.id && entry.state === 'accepted' && entry.senderRunId === input.conversation?.senderRunId && entry.recipientRunId === recipientId);
  return message && { message, outcome: state.outcomes.find(entry => entry.requestId === (message.requestId ?? message.id)) };
}

/** The merged history order: `createdAt`, then `id`, a total order a cursor can name. */
export function byCreatedAtAndId(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A peer message whose sender's ledger was deleted with the sender: the recipient's own input
 *  still carries it, so its inbox can return it (spec § 5). */
export function orphanedPeerMessage(input: AgentInput): ConversationMessage | undefined {
  if (!input.conversation) return undefined;
  // The input carries the accepted message's own hash and deadline; inputs written before they did get a stand-in hash.
  const requestHash = input.requestHash ?? createHash('sha256').update(JSON.stringify({ ...input.conversation, text: input.text })).digest('hex');
  return { id: input.id, ...input.conversation, text: input.text, createdAt: input.createdAt, ...(input.deadline ? { deadline: input.deadline } : {}), requestHash, state: 'accepted' };
}

/** A Cezar-written message (a routed question, a park notice) whose deterministic ID a peer
 *  already took: nothing is written, and `onConflict` says what happens instead. */
export function commitNewMessage(store: Pick<RunStore, 'commitConversation'>,
  rootId: string, conversation: ConversationState, delivery: { recipientRunId: string; input: AgentInput }, onConflict: () => void): boolean {
  try { store.commitConversation(rootId, conversation, delivery); return true; }
  catch (error) { if (!(error instanceof ConversationIdInUseError)) throw error; onConflict(); return false; }
}

/** The caller took part in a peer conversation with `otherId`: a peer message between them in
 *  either ledger while it exists, or, after the peer's deletion, a peer input from it that the
 *  caller still holds (spec 2026-10-27-task-communication-protocol § 2, records level). */
export function takesPart(self: RunRecord, other: RunRecord | undefined, otherId: string): boolean {
  const between = (message: ConversationMessage) => { return message.relationship === 'peer' && [message.senderRunId, message.recipientRunId].includes(otherId) && [message.senderRunId, message.recipientRunId].includes(self.id); };
  const ledger = (run: RunRecord | undefined) => conversationOf(run)?.messages ?? [];
  return ledger(self).some(between) || ledger(other).some(between) ||
    !!self.agentInputs?.some(input => input.conversation?.relationship === 'peer' && input.conversation.senderRunId === otherId);
}

/** Every conversation root, live or settled, with an open peer request to `runId`: the peer's
 *  settlement or deletion settles each at once (spec § 5, R17). Roots another process owns are its
 *  own to settle. */
export function rootsAwaitingPeer(store: Pick<RunStore, 'listConversationRootIds' | 'getRun' | 'writeRefusal'>, runId: string): string[] {
  // Only ledgers that name the run are read: the store narrows the candidates before decoding any.
  return store.listConversationRootIds(runId).filter(id => {
    const root = store.writeRefusal(id) ? undefined : store.getRun(id);
    const state = conversationOf(root);
    return !!state?.messages.some(message => message.relationship === 'peer' && message.kind === 'request' && message.state === 'accepted' &&
      message.recipientRunId === runId && !state.outcomes.some(outcome => outcome.requestId === message.id));
  });
}

/** The families a settled run's reconcile covers: a worker's parent, or a root's own family and
 *  every root that awaits it as a peer (`rootsAwaitingPeer`). */
export function settledRunFamilies(store: Pick<RunStore, 'listConversationRootIds' | 'getRun' | 'writeRefusal'>, run: RunRecord): string[] {
  const family = familyRecordIdOf(run);
  if (family === undefined) return [];
  return family === run.id ? [run.id, ...rootsAwaitingPeer(store, run.id)] : [family];
}
