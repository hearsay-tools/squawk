import { ACTIVITY_CLOSED_WINDOW_MS } from '@open-mercato/cezar-contract/activity';
import type { AgentInput, ConversationMessage, ConversationState, RequestOutcome, RunRecord } from '@open-mercato/cezar-contract';
import type { ArchivedConversationEntry, ConversationArchiveWrite } from './conversation-archive.ts';

/** A ledger commit archives settled entries only once the row holds this many messages. */
export const CONVERSATION_ARCHIVE_THRESHOLD = 256;
/** A `timed-out` request stays active this long after its outcome: a late reply is still likely. */
export const TIMED_OUT_ACTIVE_MS = 24 * 60 * 60 * 1000;

/** What compaction reads beside the ledger. */
export interface CompactionReads {
  now: number;
  /** A run's record, held or stored; undefined for a run that is gone. */
  peek(id: string): RunRecord | undefined;
  hasProjection(runId: string, projectionId: string): boolean;
  /** Worker `workerId`'s pending question is the routed request `messageId`. */
  routedAskOpen(workerId: string, messageId: string): boolean;
  /** The message `id` root `rootId`'s archive already holds. */
  archivedMessage(rootId: string, id: string): ConversationMessage | undefined;
}

/**
 * The settled entries of a root's ledger, moved out of the row (hearsay-tools/squawk#4192). Only
 * when the row holds `CONVERSATION_ARCHIVE_THRESHOLD` messages or more; then every eligible entry
 * goes, oldest first. An entry is eligible when nothing can still change it or what a participant
 * sees of it:
 * - its recipient input is delivered (and read, when a read is awaited) or absent, and that
 *   delivery step is on each participant's transcript;
 * - a request has an outcome (an open request never leaves), on each participant's transcript,
 *   older than the activity closed window, or 24 h for `timed-out`; its reply is delivered; and it
 *   is not a routed worker question whose ask is still open;
 * - any other message is older than the activity closed window.
 * An outcome in the row whose request is already archived (a late reply) follows it under the
 * same age and transcript rules. Every read by ID still finds an archived entry (`ConversationLedger`).
 */
export function compactConversation(rootId: string, state: ConversationState, reads: CompactionReads): { state: ConversationState; archive?: ConversationArchiveWrite } {
  if (state.messages.length < CONVERSATION_ARCHIVE_THRESHOLD) return { state };
  const pass = new CompactionPass(reads);
  const outcomes = new Map(state.outcomes.map(outcome => [outcome.requestId, outcome]));
  const entries: ArchivedConversationEntry[] = [];
  const messages = state.messages.filter(message => {
    const outcome = outcomes.get(message.id);
    if (!pass.archivable(message, outcome)) return true;
    entries.push({ message, ...(outcome ? { outcome } : {}) });
    return false;
  });
  const moved = new Set(entries.map(entry => entry.message.id));
  const held = new Set(messages.map(message => message.id));
  const amended: RequestOutcome[] = [];
  const kept = state.outcomes.filter(outcome => {
    if (moved.has(outcome.requestId)) return false;
    if (held.has(outcome.requestId)) return true;
    const request = reads.archivedMessage(rootId, outcome.requestId);
    if (!request || !pass.outcomeSettled(request, outcome)) return true;
    amended.push(outcome);
    return false;
  });
  if (!entries.length && !amended.length) return { state };
  return { state: { messages, outcomes: kept }, archive: { rootId, entries, outcomes: amended } };
}

/** One compaction's reads: each participant and its inputs are looked up once (a cold peer decodes
 *  from its row), and the cheap checks run first. */
class CompactionPass {
  private readonly runs = new Map<string, RunRecord | undefined>();
  private readonly inputs = new Map<string, Map<string, AgentInput>>();
  constructor(private readonly reads: CompactionReads) {}

  archivable(message: ConversationMessage, outcome: RequestOutcome | undefined): boolean {
    // An accepted request without an outcome is open: it never leaves the row.
    if (message.kind === 'request' && message.state === 'accepted' && !outcome) return false;
    if (!outcome) return this.old(message.createdAt, ACTIVITY_CLOSED_WINDOW_MS) && this.deliverySettled(message);
    if (!this.old(outcome.observedAt, outcomeWindow(outcome))) return false;
    if (message.question && this.reads.routedAskOpen(message.senderRunId, message.id)) return false;
    // The reply goes back to the requester; until it is delivered the request stays with it.
    if (outcome.replyId !== undefined && !this.inputSettled(outcome.replyId, message.senderRunId)) return false;
    return this.deliverySettled(message) && this.projected(message, outcomeProjection(outcome));
  }

  /** The outcome is old enough to leave, and each participant's transcript shows it. */
  outcomeSettled(request: ConversationMessage, outcome: RequestOutcome): boolean {
    return this.old(outcome.observedAt, outcomeWindow(outcome)) && this.projected(request, outcomeProjection(outcome));
  }

  private old(at: string, window: number): boolean { return Date.parse(at) <= this.reads.now - window; }

  private run(id: string): RunRecord | undefined {
    if (!this.runs.has(id)) this.runs.set(id, this.reads.peek(id));
    return this.runs.get(id);
  }

  private input(runId: string, id: string): AgentInput | undefined {
    let inputs = this.inputs.get(runId);
    if (!inputs) this.inputs.set(runId, inputs = new Map((this.run(runId)?.agentInputs ?? []).map(input => [input.id, input])));
    return inputs.get(id);
  }

  /** The recipient input of message `id` is delivered, and read when a read is awaited; or there is none. */
  private inputSettled(id: string, recipientRunId: string): boolean {
    const input = this.input(recipientRunId, id);
    return !input || (!!input.deliveredAt && (!input.awaitingRead || !!input.consumedAt));
  }

  /** `inputSettled`, and the delivery step `projectConversationEvents` writes is on each participant's transcript. */
  private deliverySettled(message: ConversationMessage): boolean {
    if (!this.inputSettled(message.id, message.recipientRunId)) return false;
    const input = this.input(message.recipientRunId, message.id);
    const step = input?.consumedAt ? 'consumed' : input?.deliveredAt ? 'delivered' : 'not-delivered';
    return this.projected(message, `conversation-message:${message.id}:${step}`);
  }

  private projected(message: ConversationMessage, projectionId: string): boolean {
    return [message.senderRunId, message.recipientRunId].every(runId => this.run(runId) === undefined || this.reads.hasProjection(runId, projectionId));
  }
}

function outcomeWindow(outcome: RequestOutcome): number { return outcome.status === 'timed-out' ? TIMED_OUT_ACTIVE_MS : ACTIVITY_CLOSED_WINDOW_MS; }
function outcomeProjection(outcome: RequestOutcome): string { return `request-outcome:${outcome.requestId}${outcome.status === 'replied-late' ? ':replied-late' : ''}`; }
