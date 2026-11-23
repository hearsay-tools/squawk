import { z } from 'zod';
import { askContextSchema, askRequestSchema } from './ask-schema.ts';
import { ciPrIdentitySchema, ciWaitErrorCodeSchema, ciWaitResultSchema, prWaitUntilSchema } from './ci-wait.ts';
import { listsWorkers, peerWaitResultSchema, refinePeerWaitResult, workerIdsSchema } from './delegation.ts';
import { workerOutcomeSchema, workerWaitModeSchema } from './worker-outcome.ts';
import type { PeerWaitView, WorkerCompletionWait, WorkerWait } from './delegation.ts';
import { requestOutcomeSchema } from './conversations.ts';
import type { RunRecord } from './runs.ts';
import { isUsageLimitHold } from './usage-limit-hold.ts';
import {
  WAIT_LIMIT,
  LAST_WAITS_LIMIT,
  TIMER_MIN_SECONDS,
  TIMER_MAX_SECONDS,
  PROCESS_TIMEOUT_DEFAULT_SECONDS,
  PROCESS_TIMEOUT_MAX_SECONDS,
  PROCESS_EXIT_FILE_MAX,
  PEER_WAIT_DEFAULT_SECONDS,
  PEER_WAIT_MAX_SECONDS,
  SUBAGENT_WAIT_DEADLINE_SECONDS,
  SUBAGENT_WAIT_GRACE_SECONDS,
  SUBAGENT_WAIT_CHILD_LIMIT,
  WAIT_MESSAGE_MAX,
  NOTE_MAX,
  PID_MIN,
} from './wait-limits.ts';
import { asksHuman } from './waiting-on.ts';

export {
  withRootLedger,
  requestsToPeers,
  workerWaitTargets,
  computeWaitingOn,
  asksHuman,
  asksQuestion,
  hasResolvedWait,
  resolveWaitingOn,
  type WaitingOnInput,
  type WorkerWaitTarget,
} from './waiting-on.ts';
export {
  isUsageLimitHold,
  WAIT_LIMIT,
  LAST_WAITS_LIMIT,
  TIMER_MIN_SECONDS,
  TIMER_MAX_SECONDS,
  PROCESS_TIMEOUT_DEFAULT_SECONDS,
  PROCESS_TIMEOUT_MAX_SECONDS,
  PROCESS_EXIT_FILE_MAX,
  PEER_WAIT_DEFAULT_SECONDS,
  PEER_WAIT_MAX_SECONDS,
  SUBAGENT_WAIT_DEADLINE_SECONDS,
  SUBAGENT_WAIT_GRACE_SECONDS,
  SUBAGENT_WAIT_CHILD_LIMIT,
  WAIT_MESSAGE_MAX,
  NOTE_MAX,
  PID_MIN,
};

/**
 * The wait list (spec `.ai/specs/2026-10-17-unified-waits.md`; phase 1 is
 * hearsay-tools/cezarion#1233). A run holds its open and recently settled waits in
 * `RunRecord.waits`; the agent opens one with `cezar_wait` and closes it with
 * `cezar_cancel_wait`. A wait ends only when its own event fires, its deadline passes, or someone
 * cancels it. Phase 1 carries the `ci` and `timer` kinds; phase 2 (hearsay-tools/cezarion#1234)
 * adds `human`, which the agent opens with `cezar_ask` and which has no deadline: it ends when
 * the user answers or the agent cancels it.
 * Phase 3a (hearsay-tools/cezarion#1235) adds `worker`, which waits on workers' outcomes or on
 * replies to requests and has a deadline. Phase 3b (hearsay-tools/cezarion#1301) moves the
 * completion gate's own wait into the list as a `source: 'cezar'`, `via: 'completion'` worker
 * entry with no deadline, so the list is all `computeWaitingOn` reads.
 * hearsay-tools/cezarion#1995 adds `peer` (spec `2026-10-27-task-communication-protocol` § 7): a root
 * task waits for named peer root tasks to write or to settle, with a deadline.
 * hearsay-tools/cezarion#2431 adds `subagent`: Squawk's own wait on the native subagents a turn left
 * running, with a safety deadline.
 */

const pidSchema = z.number().int().min(PID_MIN);

/** `open` → `resolved` (its event fired or its deadline passed) → `delivered`, or `cancelled`. */
export const waitPhaseSchema = z.enum(['open', 'resolved', 'delivered', 'cancelled']);
export type WaitPhase = z.infer<typeof waitPhaseSchema>;
/** What opened the wait: the tool itself, or one of the aliases that map into the same list.
 *  `no-wait` is the human wait Squawk opens when a nudged turn still ends without one; `budget`
 *  is the one it opens when the automatic-wake budget is spent; `cez-worker-wait` is
 *  `cez worker wait`, the alias that opens a `worker` wait; `completion` is the worker wait
 *  Squawk opens for a root whose done is refused twice (hearsay-tools/cezarion#1301).
 *  `cez-message-wait` is `cez message wait --peer` (hearsay-tools/cezarion#1995); a request wait
 *  from `cez message wait --request` keeps `cez-worker-wait`. `native-subagents` is the subagent
 *  wait Squawk opens when a turn ends with native subagents still running (hearsay-tools/cezarion#2431). */
export const waitViaSchema = z.enum([
  // `cezar_wait_for_ci` is kept for stored rows only: the tool was removed (hearsay-tools/cezarion#1236).
  'cezar_wait', 'cezar_wait_for_ci', 'cezar_ask', 'monitoring-line', 'schedule-wakeup', 'ask-line', 'native-ask', 'no-wait', 'budget',
  'cez-worker-wait', 'completion', 'cez-message-wait', 'native-subagents',
]);
export type WaitVia = z.infer<typeof waitViaSchema>;

const waitBaseShape = {
  id: z.uuid(),
  source: z.enum(['agent', 'cezar']),
  via: waitViaSchema,
  registeredAt: z.iso.datetime(),
  phase: waitPhaseSchema,
  resolvedAt: z.iso.datetime().optional(),
  deliveredAt: z.iso.datetime().optional(),
  cancelledAt: z.iso.datetime().optional(),
  turnId: z.string().min(1).max(256),
};

/** A pull request's checks or its merge (hearsay-tools/cezarion#1425; kind `ci` before it, which
 *  the store reads as `until: 'checks'`, `wakeOnConflict: true`). */
export const prWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('pr'),
  deadline: z.iso.datetime(),
  ...ciPrIdentitySchema.shape,
  generation: z.string().min(1).max(256),
  timeoutSeconds: z.number().int().min(1).max(7200),
  until: prWaitUntilSchema,
  wakeOnConflict: z.boolean(),
  /** The caller named a head GitHub did not show yet at registration (hearsay-tools/squawk#3972). */
  callerHead: z.literal(true).optional(),
  result: ciWaitResultSchema.optional(),
}).strict();
export type PrWaitEntry = z.infer<typeof prWaitEntrySchema>;

export const timerWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('timer'),
  deadline: z.iso.datetime(),
  seconds: z.number().int().min(TIMER_MIN_SECONDS).max(TIMER_MAX_SECONDS),
  note: z.string().max(NOTE_MAX).optional(),
}).strict();
export type TimerWaitEntry = z.infer<typeof timerWaitEntrySchema>;

/**
 * How a process wait ended (hearsay-tools/cezarion#1446): the exit file has content (`exitCode`
 * when its first line is an integer, else `exitFileNote`), the process is gone with no exit file
 * or an empty one (`exited`, code unknown), it still ran at the deadline, or the check failed (`error`).
 */
export const processWaitResultSchema = z.object({
  outcome: z.enum(['exit_file', 'exited', 'deadline', 'error']),
  observedAt: z.iso.datetime(),
  exitCode: z.number().int().min(-2147483648).max(2147483647).optional(),
  exitFileNote: z.literal('not-an-exit-code').optional(),
  diagnostic: z.string().max(512).optional(),
}).strict();
export type ProcessWaitResult = z.infer<typeof processWaitResultSchema>;

/**
 * A command the agent started in the background, watched by its PID (hearsay-tools/cezarion#1446).
 * `startToken` pins the process incarnation, so a reused PID never matches; it is absent when the
 * PID was already gone at registration or the platform cannot say. `exitFile` is the resolved
 * absolute path the command writes its exit code to.
 */
export const processWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('process'),
  deadline: z.iso.datetime(),
  timeoutSeconds: z.number().int().min(1).max(PROCESS_TIMEOUT_MAX_SECONDS),
  pid: pidSchema,
  startToken: z.string().min(1).max(256).optional(),
  exitFile: z.string().min(1).max(PROCESS_EXIT_FILE_MAX).optional(),
  note: z.string().max(NOTE_MAX).optional(),
  result: processWaitResultSchema.optional(),
}).strict();
export type ProcessWaitEntry = z.infer<typeof processWaitEntrySchema>;

/** The user. `questions` is the card the agent asked with, absent for a plain "your turn";
 *  `askSeq` is the event Squawk showed it as, once the turn ended: its `ask.requested`, the human
 *  gate a wait without a card raises, or the note that shows Squawk's own wait. */
export const humanWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('human'),
  questions: askRequestSchema.shape.questions.optional(),
  /** The card's Markdown context (hearsay-tools/cezarion#1458); absent on waits recorded before it. */
  context: askContextSchema.optional(),
  askSeq: z.number().int().nonnegative().optional(),
}).strict();
export type HumanWaitEntry = z.infer<typeof humanWaitEntrySchema>;

/**
 * Workers' outcomes, or replies to requests the run sent (hearsay-tools/cezarion#1235). The
 * target is exactly one of `workerIds` (with `revisions` and `outcomes`) and `requestIds` (with
 * `requestOutcomes`); every outcome is the first observation, durable once recorded. Unlike a
 * CI wait it has no `generation`: a worker's identity is its id. `result.reason` is why it
 * resolved; `cancelled` is a phase, and a message no longer ends a wait.
 * `wakeInputId` is an upgraded row's already-queued wake input, delivered once instead of the
 * list's `input.id === wait.id` convention.
 */
export const workerWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('worker'),
  // Squawk's completion wait has neither: it ends when its workers settle (hearsay-tools/cezarion#1301).
  deadline: z.iso.datetime().optional(),
  timeoutSeconds: z.number().int().min(1).max(PEER_WAIT_MAX_SECONDS).optional(),
  mode: workerWaitModeSchema.optional(),
  workerIds: workerIdsSchema.optional(),
  revisions: z.array(z.object({ workerId: z.uuid(), revision: z.number().int().nonnegative() }).strict()).max(32).optional(),
  outcomes: z.array(workerOutcomeSchema).max(32).optional(),
  requestIds: workerIdsSchema.optional(),
  requestOutcomes: z.array(requestOutcomeSchema).max(32).optional(),
  result: z.object({ reason: z.enum(['outcome', 'timeout']) }).strict().optional(),
  wakeInputId: z.uuid().optional(),
}).strict().superRefine((wait, ctx) => {
  const hasDeadline = wait.deadline !== undefined;
  const hasTimeout = wait.timeoutSeconds !== undefined;
  if (wait.source === 'agent') {
    if (!hasDeadline) ctx.addIssue({ code: 'custom', message: 'an agent worker wait requires a deadline', path: ['deadline'] });
    if (!hasTimeout) ctx.addIssue({ code: 'custom', message: 'an agent worker wait requires timeoutSeconds', path: ['timeoutSeconds'] });
  } else if (hasDeadline !== hasTimeout) {
    ctx.addIssue({ code: 'custom', message: 'a cezar worker wait takes deadline and timeoutSeconds together or neither', path: [hasDeadline ? 'timeoutSeconds' : 'deadline'] });
  }
  const byWorker = wait.workerIds !== undefined;
  const byRequest = wait.requestIds !== undefined;
  if (byWorker === byRequest) {
    ctx.addIssue({ code: 'custom', message: 'a worker wait names workerIds or requestIds, exactly one', path: [byWorker ? 'requestIds' : 'workerIds'] });
    return;
  }
  if (wait.mode === 'one' && (wait.workerIds ?? wait.requestIds)?.length !== 1) {
    ctx.addIssue({ code: 'custom', message: 'one mode requires exactly one id', path: ['mode'] });
  }
  const own = byWorker ? ['revisions', 'outcomes'] as const : ['requestOutcomes'] as const;
  const other = byWorker ? ['requestOutcomes'] as const : ['revisions', 'outcomes'] as const;
  for (const key of own) {
    if (wait[key] === undefined) ctx.addIssue({ code: 'custom', message: `${key} is required with ${byWorker ? 'workerIds' : 'requestIds'}`, path: [key] });
  }
  for (const key of other) {
    if (wait[key] !== undefined) ctx.addIssue({ code: 'custom', message: `${key} does not go with ${byWorker ? 'workerIds' : 'requestIds'}`, path: [key] });
  }
});
export type WorkerWaitEntry = z.infer<typeof workerWaitEntrySchema>;
/** An entry the legacy `WorkerWait` shape can render: its deadline is required there. Squawk's
 *  deadline-less completion wait is not one (hearsay-tools/cezarion#1301). */
export type DeadlinedWorkerWaitEntry = WorkerWaitEntry & { deadline: string };
export const hasWorkerDeadline = (entry: WorkerWaitEntry): entry is DeadlinedWorkerWaitEntry => entry.deadline !== undefined;

/** Why a peer wait resolved (hearsay-tools/cezarion#1995): `delegation.ts` defines the union, which
 *  the CLI view shares. */
export { peerWaitResultSchema, type PeerWaitResult } from './delegation.ts';

/**
 * Named peer root tasks (hearsay-tools/cezarion#1995, spec `2026-10-27-task-communication-protocol`
 * § 7). It is the one wait a message closes, and only a message from a peer it names; human and
 * family messages wake the run and leave it open. It always has a deadline, its liveness bound.
 */
export const peerWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('peer'),
  deadline: z.iso.datetime(),
  timeoutSeconds: z.number().int().min(1).max(PEER_WAIT_MAX_SECONDS),
  peerIds: workerIdsSchema,
  result: peerWaitResultSchema.optional(),
}).strict().superRefine(refinePeerWaitResult);
export type PeerWaitEntry = z.infer<typeof peerWaitEntrySchema>;

/** A peer wait as `cez message wait --peer` and `cez message cancel-wait` answer it. */
export function peerWaitView(entry: PeerWaitEntry): PeerWaitView {
  return { id: entry.id, peerIds: entry.peerIds, deadline: entry.deadline, phase: entry.phase, ...(entry.result ? { result: entry.result } : {}) };
}

/** One native subagent a subagent wait follows: the runner's id for its root task item, and its
 *  last status. `cancelled` is a child the runner stopped or declined. */
export const subagentChildSchema = z.object({
  id: z.string().min(1).max(256),
  status: z.enum(['running', 'completed', 'failed', 'cancelled']),
}).strict();
export type SubagentChild = z.infer<typeof subagentChildSchema>;

/** Why a subagent wait ended (hearsay-tools/cezarion#2431): every child ended (`settled`), the safety
 *  deadline passed (`timeout`), a restart found no session to hold the children (`interrupted`), or
 *  the runner resumed the parent itself (`superseded`, a cancelled entry). */
export const subagentWaitResultSchema = z.object({ reason: z.enum(['settled', 'timeout', 'interrupted', 'superseded']) }).strict();
export type SubagentWaitResult = z.infer<typeof subagentWaitResultSchema>;

/**
 * The native subagents a turn left running (hearsay-tools/cezarion#2431). Squawk opens it at the
 * turn end instead of a monitoring timer: the park keeps its session, which holds the children, and
 * a monitoring-pool slot. It resolves when every child ended and the runner did not resume the
 * parent within a grace, or at its deadline, which each child event moves.
 */
export const subagentWaitEntrySchema = z.object({
  ...waitBaseShape,
  kind: z.literal('subagent'),
  source: z.literal('cezar'),
  via: z.literal('native-subagents'),
  deadline: z.iso.datetime(),
  children: z.array(subagentChildSchema).min(1).max(SUBAGENT_WAIT_CHILD_LIMIT),
  result: subagentWaitResultSchema.optional(),
}).strict();
export type SubagentWaitEntry = z.infer<typeof subagentWaitEntrySchema>;

/** The children a subagent wait still waits on. */
export function runningSubagents(wait: Pick<SubagentWaitEntry, 'children'>): number {
  return wait.children.filter((child) => child.status === 'running').length;
}

/** An open plugin-owned wait; its data remains readable without the plugin installed. */
export const pluginWaitEntrySchema = z.object({
  ...waitBaseShape,
  via: z.string().min(1).max(64),
  kind: z.literal('plugin'),
  pluginKind: z.string().min(1).max(64),
  deadline: z.iso.datetime().optional(),
  summary: z.string().max(256),
  payload: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type PluginWaitEntry = z.infer<typeof pluginWaitEntrySchema>;

export const waitSchema = z.discriminatedUnion('kind', [prWaitEntrySchema, timerWaitEntrySchema, humanWaitEntrySchema, workerWaitEntrySchema, processWaitEntrySchema, peerWaitEntrySchema, subagentWaitEntrySchema, pluginWaitEntrySchema]);
export type Wait = z.infer<typeof waitSchema>;

// ---- what the tool answers share ----------------------------------------------------------

/** One still-open wait as both tools list it back to the agent. A PR, timer, worker, process,
 *  peer or subagent wait carries its deadline; a human wait has none. */
const openWaitFields = { wait_id: z.uuid(), summary: z.string().max(256) };
export const openWaitSchema = z.discriminatedUnion('kind', [
  z.object({ ...openWaitFields, kind: z.enum(['pr', 'timer', 'worker', 'process', 'peer', 'subagent']), deadline: z.iso.datetime() }).strict(),
  z.object({ ...openWaitFields, kind: z.literal('human') }).strict(),
  z.object({ ...openWaitFields, kind: z.literal('plugin'), pluginKind: z.string().min(1).max(64), deadline: z.iso.datetime().optional() }).strict(),
]);
export type OpenWait = z.infer<typeof openWaitSchema>;

export const waitErrorCodeSchema = z.enum([...ciWaitErrorCodeSchema.options, 'timers_disabled', 'wake_budget_spent', 'denied_scope',
  'exit_file_outside', 'process_not_allowed', 'process_not_owned', 'duplicate_deadline', 'operation_conflict', 'outcome_unknown',
  // hearsay-tools/cezarion#2784: a peer wait on a task whose messaging switch is off.
  'messaging_off']);
export type WaitErrorCode = z.infer<typeof waitErrorCodeSchema>;

export const waitRegistrationReceiptSchema = z.object({
  operationId: z.uuid(), requestHash: z.string().regex(/^[0-9a-f]{64}$/),
  wait: waitSchema, deduplicated: z.boolean(),
}).strict();
export type WaitRegistrationReceipt = z.infer<typeof waitRegistrationReceiptSchema>;

/** The refusals a question can meet: the session's, the run's capacity, and an autonomous run. */
export const askErrorCodeSchema = z.enum([
  'invalid_request', 'capacity', 'persistence', 'unavailable', 'unauthorized', 'autonomous_run',
  'manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping', 'session_replaced',
  'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch', 'worker_wait_pending',
  'worker_execution_stopped', 'root_finish_pending', 'supervisor_is_worker',
]);
export type AskErrorCode = z.infer<typeof askErrorCodeSchema>;

// `worker_wait_pending` (here and in the ask and CI wait codes) was the old completion wait's
// refusal; it is kept for old clients and never returned since hearsay-tools/cezarion#1301.
// `not_final_step` is kept the same way: every agent step accepts a done since
// hearsay-tools/cezarion#1620.
export const doneErrorCodeSchema = z.enum([
  'workers_outstanding', 'workers_uncollected', 'worker_questions', 'requests_outstanding', 'requests_unanswered', 'human_question_pending', 'worker_wait_pending',
  'root_finish_pending', 'not_final_step', 'manager_disposed', 'capability_revoked', 'run_missing', 'run_not_running', 'run_stopping',
  'session_replaced', 'session_closed', 'run_cancelled', 'finish_requested', 'generation_mismatch', 'invalid_request',
  'unavailable', 'input_pending',
]);
export type DoneErrorCode = z.infer<typeof doneErrorCodeSchema>;

/** Input the run owes the agent when it calls `cezar_done`: a resolved wait's result not yet
 *  delivered (`wait_result`, with the wait's kind), a message or result queued for delivery
 *  (`queued`; a human message has no `input_id`), a submission still waiting for its
 *  acknowledgement (`in_flight`), or an acknowledged one the model has not read (`unread`). */
export const doneOwedInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('wait_result'), wait_id: z.string(), wait_kind: z.string() }).strict(),
  z.object({ kind: z.literal('queued'), input_id: z.string().optional(), source: z.string() }).strict(),
  z.object({ kind: z.literal('in_flight'), input_id: z.string() }).strict(),
  z.object({ kind: z.literal('unread'), input_id: z.string() }).strict(),
]);
export type DoneOwedInput = z.infer<typeof doneOwedInputSchema>;


// ---- what the run is waiting on -----------------------------------------------------------

/**
 * The run's top open wait, by the spec's order: human > usage limit > workers > peers > subagents >
 * PR > process > plugin > timer. A summary field: lists and `deriveAttention` read it instead of the wait list.
 */
const waitingOnUnionSchema = z.discriminatedUnion('kind', [
  /** `shown` once the user sees the question (its `askSeq`): attention reads that as Needs you at
   *  any status, a wake turn's included (phase 4b, hearsay-tools/cezarion#1236). */
  z.object({ kind: z.literal('human'), shown: z.literal(true).optional() }),
  // `autoResumeAt` is free text on the record, so the instant it carries is too.
  z.object({ kind: z.literal('usage-limit'), at: z.string() }),
  /** The workers still owed an outcome, or the replies awaited; 0 when the row cannot count.
   *  `replies` when every open worker entry waits on request replies, so a summary, which carries
   *  no `waits`, can still say so (hearsay-tools/cezarion#1235). `peers` when one of those
   *  requests went to a peer task (hearsay-tools/cezarion#1995). */
  z.object({ kind: z.literal('workers'), count: z.number().int().nonnegative(), replies: z.literal(true).optional(), peers: z.literal(true).optional() }),
  /** The peer tasks the open peer waits name, counted once each (hearsay-tools/cezarion#1995). */
  z.object({ kind: z.literal('peers'), count: z.number().int().nonnegative() }),
  /** The native subagents still running, over every open subagent wait (hearsay-tools/cezarion#2431). */
  z.object({ kind: z.literal('subagents'), count: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('pr'),
    until: prWaitUntilSchema,
    waitId: z.uuid(),
    prUrl: ciPrIdentitySchema.shape.prUrl,
    repository: ciPrIdentitySchema.shape.repository,
    prNumber: ciPrIdentitySchema.shape.prNumber,
    deadline: z.iso.datetime(),
  }),
  /** A background command (hearsay-tools/cezarion#1446). */
  z.object({ kind: z.literal('process'), waitId: z.uuid(), pid: pidSchema, deadline: z.iso.datetime(), note: z.string().max(NOTE_MAX).optional() }),
  z.object({ kind: z.literal('plugin'), pluginKind: z.string().min(1).max(64), waitId: z.uuid(), summary: z.string().max(256), deadline: z.iso.datetime().optional() }),
  z.object({ kind: z.literal('timer'), waitId: z.uuid(), at: z.iso.datetime(), note: z.string().max(NOTE_MAX).optional() }),
]);
/** Stored summaries written before hearsay-tools/cezarion#1425 carry `{ kind: 'ci' }`: a checks wait. */
export const waitingOnSchema = z.preprocess(
  (value) => value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'ci' ? { ...value, kind: 'pr', until: 'checks' } : value,
  waitingOnUnionSchema,
);
export type WaitingOn = z.infer<typeof waitingOnSchema>;

/**
 * A run's worker wait in the old `WorkerWait` shape, for views that still show one: the newest
 * open or owed `worker` entry the agent registered (hearsay-tools/cezarion#1235). Squawk's
 * completion wait has no deadline, which that shape requires, so it is not one
 * (hearsay-tools/cezarion#1301). An open entry reads `parked` once the run waits on it, unless a
 * pending question holds the run.
 */
export function workerWaitView(run: Partial<Pick<RunRecord, 'status' | 'waits' | 'delegation'>>): WorkerWait | undefined {
  const delegation = run.delegation;
  if (!delegation || delegation.role === 'invalid') return undefined;
  const entry = (run.waits ?? []).filter((wait): wait is DeadlinedWorkerWaitEntry => wait.kind === 'worker' && hasWorkerDeadline(wait) && (wait.phase === 'open' || wait.phase === 'resolved')).at(-1);
  if (!entry) return undefined;
  const legacy = workerWaitEntryToLegacy(entry);
  return entry.phase === 'open' && run.status === 'waiting' && !asksHuman(run) ? { ...legacy, phase: 'parked' } : legacy;
}

/** The newest open or owed deadline-less completion entry, which `workerWaitView` leaves out. */
export function completionWaitEntry(waits: readonly Wait[] | undefined, workerId?: string): WorkerWaitEntry | undefined {
  return (waits ?? []).filter((wait): wait is WorkerWaitEntry => wait.kind === 'worker' && wait.via === 'completion' && !hasWorkerDeadline(wait) &&
    (wait.phase === 'open' || wait.phase === 'resolved') && (workerId === undefined || !!wait.workerIds?.includes(workerId))).at(-1);
}

/**
 * Squawk's completion wait as inspection and the relationships view show it, read from the list
 * like `workerWaitView` (hearsay-tools/cezarion#1301): its phases map as the legacy shape's do.
 */
export function workerCompletionWaitProjection(entry: WorkerWaitEntry, run: Partial<Pick<RunRecord, 'status' | 'waits'>>): WorkerCompletionWait {
  const reason = entry.phase === 'cancelled' ? 'cancelled' : entry.phase === 'open' ? undefined : entry.result?.reason;
  const parked = entry.phase === 'open' && run.status === 'waiting' && !asksHuman(run);
  return {
    id: entry.id,
    via: 'completion',
    workerIds: entry.workerIds ?? [],
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    ...(entry.revisions?.length ? { revisions: entry.revisions } : {}),
    ...(reason === undefined ? {} : { reason }),
    phase: parked ? 'parked' : entry.phase === 'open' ? 'registered' : 'wake-pending',
    outcomes: entry.outcomes ?? [],
    wakeId: entry.wakeInputId ?? entry.id,
  };
}

/** A run's deadline-less completion wait in its projection, for the relationships view: for every
 *  run that lists workers, a supervising worker included. */
export function completionWaitView(run: Partial<Pick<RunRecord, 'status' | 'waits' | 'delegation'>>): WorkerCompletionWait | undefined {
  if (!listsWorkers(run.delegation)) return undefined;
  const entry = completionWaitEntry(run.waits);
  return entry ? workerCompletionWaitProjection(entry, run) : undefined;
}

/**
 * A worker wait as `cez worker wait` and `cez worker cancel-wait` answer it: the old
 * `WorkerWait` shape, whose wire stays unchanged (hearsay-tools/cezarion#1235). Open is
 * `registered`; every settled phase is `wake-pending` and the reason says how it ended.
 */
export function workerWaitEntryToLegacy(entry: DeadlinedWorkerWaitEntry): WorkerWait {
  const reason = entry.phase === 'cancelled' ? 'cancelled' : entry.phase === 'open' ? undefined : entry.result?.reason;
  return {
    id: entry.id,
    workerIds: entry.workerIds ?? [],
    ...(entry.requestIds === undefined ? {} : { requestIds: entry.requestIds }),
    ...(entry.requestOutcomes === undefined ? {} : { requestOutcomes: entry.requestOutcomes }),
    deadline: entry.deadline,
    ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    // An upgraded wait that never recorded revisions carries an empty list; the legacy shape had none.
    ...(entry.revisions?.length ? { revisions: entry.revisions } : {}),
    ...(reason === undefined ? {} : { reason }),
    phase: entry.phase === 'open' ? 'registered' : 'wake-pending',
    outcomes: entry.outcomes ?? [],
    wakeId: entry.wakeInputId ?? entry.id,
  };
}
