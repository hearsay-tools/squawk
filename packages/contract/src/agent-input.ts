import { z } from 'zod';
import { conversationAttributionSchema } from './conversations.ts';

/**
 * An input Squawk queues for an agent session: a worker's message to its parent, a parent's
 * steering, a peer message or a lifecycle notice. Many Squawk modules read only this schema, so it
 * lives apart from `delegation.ts`, which re-exports it (hearsay-tools/squawk#3245).
 */

export const inboxClaimSchema = z.object({
  receiptId: z.uuid(), generation: z.uuid(), expiresAt: z.iso.datetime(), acknowledgedAt: z.iso.datetime().optional(),
  /** Optional on read for receipts persisted before member manifests existed. */
  memberIds: z.array(z.uuid()).min(1).max(32).refine(ids => new Set(ids).size === ids.length).optional(),
}).strict();
export type InboxClaim = z.infer<typeof inboxClaimSchema>;

export const agentInputSchema = z.object({
  conversation: conversationAttributionSchema.optional(),
  id: z.uuid(),
  source: z.enum(['agent', 'lifecycle']),
  parentRunId: z.uuid(),
  text: z.string().min(1).max(100_000),
  createdAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().optional(),
  /** The model received it, when the harness can show that (#505). Absent on
   * unobservable backends and on records written before #505. */
  consumedAt: z.iso.datetime().optional(),
  /** Accepted by a harness that reports reading, and not read yet. A restart replays
   * such input; records written before #505 never carry it, so nothing historical replays. */
  awaitingRead: z.literal(true).optional(),
  inboxClaim: inboxClaimSchema.optional(),
  /** A completion refusal Squawk queued for a closed session (hearsay-tools/cezarion#1301): its
   * delivery is the nudge's turn, bounded by the nudge's reply bound, and a session that closes
   * before it is a failed delivery. `undelivered-question` is Squawk's answer to a worker question
   * that could not reach its live parent (hearsay-tools/cezarion#2410). Absent on every other input
   * and on records written before. */
  purpose: z.enum(['completion-refusal', 'undelivered-question']).optional(),
  /** A peer message's own hash and request deadline (hearsay-tools/cezarion#1990): the sender's
   *  ledger can be deleted before the recipient reads it. Absent on family and lifecycle inputs. */
  requestHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  deadline: z.iso.datetime().optional(),
}).strict();
export type AgentInput = z.infer<typeof agentInputSchema>;
