import type { ConversationMessage, PlanEntry, RequestOutcome, RunEvent, StopReason, UiItem } from '@open-mercato/cezar-api-client'
import { runnerSchema } from '@open-mercato/cezar-api-client/contract/runner'

import type {
  ThreadAsk,
  ThreadConversationDelivery,
  ThreadConversationMessage,
  ThreadEntry,
  ThreadFailureSource,
  ThreadNote,
  ThreadPermission,
  ThreadProviderAuthRequired,
  ThreadState,
  ThreadTurn,
} from './thread-state'

/**
 * The explicit state `reduceThread` folds events into (hearsay-tools/cezarion#1597). Each event
 * family's reducer in `thread-fold-reducers.ts` reads and writes only this object, so the fold
 * stays pure: one `FoldState` per call, never shared between calls.
 */

/** `origin` is fold-internal: it is what lets the mixed-file rule drop exactly the v1-derived
 *  items and nothing else when a turn turns out to be v2-covered. */
export interface DraftEntry {
  origin: 'v1' | 'v2' | 'meta'
  entry: ThreadEntry
  /** The seq of the event that placed this entry in its turn. */
  firstSeq: number
  /** The seq of the latest event that changed this entry. */
  lastSeq: number
  /** A v2 message or reasoning item that started and has not completed yet. */
  streaming?: boolean | undefined
}

export interface DraftFailure {
  draft: DraftEntry
  cause: string
  primarySource: ThreadFailureSource
  primaryText: string
  stepId?: string | undefined
  fatal: boolean
}

export interface DraftTurn {
  id: string
  turnId?: string | undefined
  userMessage?: ThreadTurn['userMessage']
  startedAt?: string | undefined
  entries: DraftEntry[]
  /** Failure notes recorded in this turn so duplicate sources fold into one entry (hearsay-tools/squawk#4018). */
  failures?: DraftFailure[] | undefined
  planEntries?: PlanEntry[]
  completed?: { stopReason: StopReason; costUsd?: number; ts?: string | undefined }
  /** True once any v2 `item.*` event landed in this turn — the dedup latch. */
  v2Items: boolean
}

export interface FoldState {
  turns: DraftTurn[]
  /** stepId:itemId → live item. Runner sessions restart ids at `item_1`, while every current
   *  persisted event is stamped with its workflow step. Old recordings without a step id keep
   *  the historical bare-id lookup semantics. */
  itemsById: Map<string, { turn: DraftTurn; entry: DraftEntry }>
  sessionEnded?: ThreadState['sessionEnded']
  turnSeq: number
  /** The seq of the event being folded. */
  eventSeq: number
  /** The latest unresolved AskUser card (#473). The next `user-message` resolves
   *  it client-side (only one ask is ever pending — the agent asks once, then
   *  parks `waiting` until the user answers). */
  pendingAsk?: ThreadAsk | undefined
  permissions: Map<string, ThreadPermission>
  conversationEntries: Map<string, ThreadConversationMessage>
  outcomesByRequest: Map<string, RequestOutcome>
  seenInputs: Set<string>
  /** The live card per registered port (#781): state events mutate it, a re-registration replaces it. */
  previewByPort: Map<number, { turn: DraftTurn; draft: DraftEntry }>
  /** Whether a `handoff` event already turned notify on, so a later one reads as a note (#589). */
  handedOff: boolean
}

export function createFoldState(): FoldState {
  return {
    turns: [],
    itemsById: new Map(),
    turnSeq: 0,
    eventSeq: 0,
    permissions: new Map(),
    conversationEntries: new Map(),
    outcomesByRequest: new Map(),
    seenInputs: new Set(),
    previewByPort: new Map(),
    handedOff: false,
  }
}

// ---- value parsers ------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** ` · 14:02` (24-hour, like every thread clock), or nothing for an unparseable stamp. */
export function clockTime(ts: unknown): string {
  const at = typeof ts === 'string' ? new Date(ts) : undefined
  if (!at || Number.isNaN(at.getTime())) return ''
  return ` · ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`
}

/**
 * A wall-clock stamp the thread is willing to render (#941). `ts` is required on the wire and
 * has always been written, but `runEventSchema` is deliberately loose and NDJSON transcripts are
 * plain files people edit — so an absent, non-string or unparseable stamp becomes `undefined`
 * here, and the turn renders exactly as it did before rather than printing `Invalid Date`.
 *
 * `parse()` in `thread-time.tsx` applies the same test at the render layer and returns the `Date`;
 * this one keeps the string, because the reduced thread carries stamps rather than formats them.
 */
export function stamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined
  return Number.isFinite(new Date(value).getTime()) ? value : undefined
}

/** A runner id from an event: any id `runnerSchema` accepts. */
export function providerId(value: unknown): ThreadProviderAuthRequired['provider'] | undefined {
  return runnerSchema.safeParse(value).data
}

// ---- turns --------------------------------------------------------------------------------

export function newTurn(fold: FoldState, sourceSeq?: number): DraftTurn {
  fold.turnSeq += 1
  const turn: DraftTurn = {
    id: sourceSeq === undefined ? `turn-fallback-${fold.turnSeq}` : `turn-seq-${sourceSeq}`,
    entries: [],
    v2Items: false,
  }
  fold.turns.push(turn)
  return turn
}

export function currentTurn(fold: FoldState): DraftTurn {
  return fold.turns.at(-1) ?? newTurn(fold)
}

/** Append a cezar-owned entry (`origin: 'meta'`) to the current turn: it survives every dedup. */
export function pushMeta(fold: FoldState, entry: ThreadEntry): DraftEntry {
  const draft: DraftEntry = { origin: 'meta', entry, firstSeq: fold.eventSeq, lastSeq: fold.eventSeq }
  currentTurn(fold).entries.push(draft)
  return draft
}

// ---- failure folding (hearsay-tools/squawk#4018) ------------------------------------------

const FAILURE_WRAPPERS = [
  /^run failed\s+[—-]\s+/,
  /^continue failed(?:\s+[—-]\s+|:\s+)/,
  /^step\s+"[^"]+"\s+failed:\s+/,
  /^step\s+\S+\s+failed\s+[—-]\s+/,
] as const

const FAILURE_LIFECYCLE = /^(?:run failed\s+[—-]\s+|continue failed(?:\s+[—-]\s+|:\s+))/

export function normalizeFailureCause(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** Strip Squawk's outer run/continue/step failure wrappers so sources sharing one cause match. */
export function unwrapFailureCause(text: string): string {
  let current = text.trim()
  let changed = true
  while (changed) {
    changed = false
    for (const pattern of FAILURE_WRAPPERS) {
      const next = current.replace(pattern, '').trim()
      if (next !== current && next !== '') {
        current = next
        changed = true
      }
    }
  }
  return normalizeFailureCause(current)
}

export function addFailureDetail(failure: DraftFailure, source: ThreadFailureSource, text: string): void {
  if (source === failure.primarySource && text === failure.primaryText) return
  if (failure.draft.entry.kind !== 'note') return
  const note: ThreadNote = failure.draft.entry
  if (note.details?.some((item) => item.source === source && item.text === text)) return
  note.details = [...(note.details ?? []), { source, text }]
}

function findMatchingFailure(turn: DraftTurn, cause: string, stepId: string | undefined): DraftFailure | undefined {
  const failures = turn.failures
  if (!failures) return undefined
  for (let i = failures.length - 1; i >= 0; i -= 1) {
    const candidate = failures[i]!
    if (cause !== '' && candidate.cause === cause) return candidate
    if (cause === '' && candidate.fatal && (stepId === undefined || candidate.stepId === undefined || candidate.stepId === stepId)) {
      return candidate
    }
  }
  return undefined
}

export function recordFailure(
  fold: FoldState,
  event: RunEvent,
  input: {
    id: string
    source: ThreadFailureSource
    text: string
    cause: string
    stepId?: string | undefined
    fatal: boolean
  },
): void {
  const turn = currentTurn(fold)
  const existing = findMatchingFailure(turn, input.cause, input.stepId)
  if (existing) {
    existing.draft.lastSeq = Math.max(existing.draft.lastSeq, event.seq)
    if (input.fatal) existing.fatal = true
    if (input.stepId !== undefined && existing.stepId === undefined) existing.stepId = input.stepId
    addFailureDetail(existing, input.source, input.text)
    return
  }
  const draft = pushMeta(fold, { kind: 'note', id: input.id, text: input.text, tone: 'danger' })
  const failure: DraftFailure = {
    draft,
    cause: input.cause,
    primarySource: input.source,
    primaryText: input.text,
    ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
    fatal: input.fatal,
  }
  turn.failures = [...(turn.failures ?? []), failure]
}

/** Fold a `run failed — …` / `continue failed — …` lifecycle line into its matching failure entry. */
export function foldLifecycleFailure(fold: FoldState, event: RunEvent, text: string): boolean {
  if (!FAILURE_LIFECYCLE.test(text)) return false
  const turn = fold.turns.at(-1)
  if (!turn) return false
  const cause = unwrapFailureCause(text)
  if (cause === '') return false
  const existing = findMatchingFailure(turn, cause, str(event.stepId))
  if (!existing) return false
  existing.draft.lastSeq = Math.max(existing.draft.lastSeq, event.seq)
  existing.fatal = true
  addFailureDetail(existing, 'lifecycle', text)
  return true
}

/** Mark the matching turn failure fatal when `session.ended` closes with `reason: 'error'`. */
export function markTurnFailureFatal(fold: FoldState, event: RunEvent, message: string | undefined): void {
  const turn = fold.turns.at(-1)
  if (!turn) return
  const cause = message ? unwrapFailureCause(message) : ''
  const existing = findMatchingFailure(turn, cause, str(event.stepId))
  if (existing) existing.fatal = true
}

export function expirePermissions(fold: FoldState): void {
  for (const permission of fold.permissions.values()) {
    if (permission.status === 'pending') permission.status = 'expired'
  }
}

// ---- v2 items -----------------------------------------------------------------------------

export function itemKey(event: RunEvent, itemId: string): string {
  const stepId = str(event.stepId)
  return stepId === undefined ? itemId : `${stepId}:${itemId}`
}

/**
 * The dedup latch flips: this turn is v2-covered, so every v1-synthesized TOOL in it is
 * a duplicate of something v2 already describes (or is about to). Tools can be dropped
 * sight-unseen because v2 tool coverage is total across backends and ids are shared —
 * `tool-call`'s own `turn.v2Items` guard already suppresses the rest.
 *
 * v1 MESSAGES are deliberately NOT dropped here (#agent-log-vanishing-text): a turn being
 * v2-covered for tools does NOT prove its prose has a v2 twin. Claude's result fallback
 * (claude-cli-runner.ts emits a v1 `text` from `msg.result`) had no v2 counterpart, so
 * this blanket drop deleted the agent's only message a moment after it rendered. The
 * twinned ones are removed by text at the end of the fold, where the evidence exists.
 */
function markV2Covered(fold: FoldState, turn: DraftTurn): void {
  turn.v2Items = true
  for (const dropped of turn.entries) {
    if (dropped.origin === 'v1' && dropped.entry.kind === 'tool') fold.itemsById.delete(dropped.entry.id)
  }
  turn.entries = turn.entries.filter((e) => !(e.origin === 'v1' && e.entry.kind === 'tool'))
}

export function upsertV2(fold: FoldState, turn: DraftTurn, raw: UiItem, key: string, ts?: string, streaming = false): void {
  // Clone: deltas append in place, and the event object off the wire must stay untouched.
  // Assistant (and rare in-stream user) messages carry the completing event's clock (#435).
  const item = raw.kind === 'message' && ts !== undefined ? { ...raw, ts } : { ...raw }
  // A hook (#961) is no evidence of v2 tool coverage, and a Claude SessionStart hook lands
  // before `turn.started`, which must still attach to the prompt's turn.
  if (!turn.v2Items && item.kind !== 'hook') markV2Covered(fold, turn)
  const existing = fold.itemsById.get(key)
  if (existing && existing.turn === turn) {
    existing.entry.entry = item
    existing.entry.lastSeq = fold.eventSeq
    existing.entry.streaming = streaming
    return
  }
  const draft: DraftEntry = { origin: 'v2', entry: item, firstSeq: fold.eventSeq, lastSeq: fold.eventSeq, streaming }
  turn.entries.push(draft)
  fold.itemsById.set(key, { turn, entry: draft })
}

// ---- conversation envelopes ---------------------------------------------------------------

/** Delivery only moves forward: a later, lower projection never downgrades it (#505). */
const DELIVERY_RANK: Record<ThreadConversationDelivery, number> = { 'not-delivered': 0, queued: 1, delivered: 2, consumed: 3 }

export interface ConversationUpsert {
  id: string
  text: string
  senderRunId: string
  recipientRunId: string
  kind: ConversationMessage['kind']
  requestId?: string | undefined
  /** `peer` for a message between two root tasks; absent reads as `family`. */
  relationship?: ConversationMessage['relationship'] | undefined
  state?: ConversationMessage['state'] | undefined
  createdAt?: string
  requestHash?: string
  deadline?: string | undefined
  instruction?: string | undefined
  resumed?: true | undefined
}

export interface ConversationTiming {
  deliveredAt?: string | undefined
  consumedAt?: string | undefined
  recordedAt?: string
}

/** The optional envelope fields a later projection may fill in; absent ones never erase. */
const OPTIONAL_MESSAGE_FIELDS = ['instruction', 'resumed', 'requestId', 'relationship', 'state', 'createdAt', 'requestHash', 'deadline'] as const

type OptionalMessageFields = Partial<Pick<ConversationUpsert, (typeof OPTIONAL_MESSAGE_FIELDS)[number]>>

function definedMessageFields(message: ConversationUpsert): OptionalMessageFields {
  const fields: OptionalMessageFields = {}
  for (const field of OPTIONAL_MESSAGE_FIELDS) {
    if (message[field] !== undefined) Object.assign(fields, { [field]: message[field] })
  }
  return fields
}

function attachOutcome(fold: FoldState, entry: ThreadConversationMessage): void {
  if (entry.messageKind !== 'request') return
  const outcome = fold.outcomesByRequest.get(entry.messageId)
  if (outcome) {
    entry.outcome = { status: outcome.status, ...(outcome.replyId !== undefined ? { replyId: outcome.replyId } : {}), observedAt: outcome.observedAt }
  }
}

/** Re-attach the request's recorded outcome to its envelope, when the envelope is known. */
export function attachRequestOutcome(fold: FoldState, requestId: string): void {
  const existing = fold.conversationEntries.get(requestId)
  if (existing) attachOutcome(fold, existing)
}

function mergeConversation(
  existing: ThreadConversationMessage,
  message: ConversationUpsert,
  delivery: ThreadConversationDelivery,
  timing: ConversationTiming,
): void {
  if (DELIVERY_RANK[existing.delivery] < DELIVERY_RANK.delivered || DELIVERY_RANK[delivery] > DELIVERY_RANK[existing.delivery]) existing.delivery = delivery
  if (message.text !== '') existing.text = message.text
  Object.assign(existing, definedMessageFields(message))
  if (timing.deliveredAt !== undefined) existing.deliveredAt = timing.deliveredAt
  if (timing.consumedAt !== undefined) existing.consumedAt = timing.consumedAt
  if (timing.recordedAt !== undefined && (delivery === 'delivered' || existing.delivery !== 'delivered')) existing.recordedAt = timing.recordedAt
}

export function upsertConversation(
  fold: FoldState,
  message: ConversationUpsert,
  delivery: ThreadConversationDelivery,
  timing: ConversationTiming,
): void {
  const existing = fold.conversationEntries.get(message.id)
  if (existing) {
    mergeConversation(existing, message, delivery, timing)
    attachOutcome(fold, existing)
    return
  }
  const entry: ThreadConversationMessage = {
    kind: 'conversation',
    id: `conversation-message:${message.id}`,
    messageId: message.id,
    text: message.text,
    senderRunId: message.senderRunId,
    recipientRunId: message.recipientRunId,
    messageKind: message.kind,
    delivery,
    ...timing,
    ...definedMessageFields(message),
  }
  attachOutcome(fold, entry)
  fold.conversationEntries.set(message.id, entry)
  pushMeta(fold, entry)
}
