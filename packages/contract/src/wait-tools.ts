import { z } from 'zod';
import { askContextSchema, askRequestSchema } from './ask-schema.ts';
import { ciWaitRequestSchema } from './ci-wait.ts';
import { workerIdsSchema } from './delegation.ts';
import { workerWaitModeSchema } from './worker-outcome.ts';
import { NOTE_MAX, PID_MIN, PEER_WAIT_DEFAULT_SECONDS, PEER_WAIT_MAX_SECONDS, PROCESS_EXIT_FILE_MAX, PROCESS_TIMEOUT_DEFAULT_SECONDS, PROCESS_TIMEOUT_MAX_SECONDS, TIMER_MAX_SECONDS, TIMER_MIN_SECONDS, WAIT_LIMIT, WAIT_MESSAGE_MAX } from './wait-limits.ts';
import { askErrorCodeSchema, doneErrorCodeSchema, doneOwedInputSchema, openWaitSchema, waitErrorCodeSchema, waitPhaseSchema } from './waits.ts';

/**
 * The agent tools' requests and answers: `cezar_wait`, `cezar_ask`, `cezar_cancel_wait` and
 * `cezar_done`. They live apart from the stored wait list in `waits.ts`, so a module that reads only
 * a wait entry does not load the tool schemas (hearsay-tools/squawk#4143).
 */

const pidSchema = z.number().int().min(PID_MIN);

const oneModeTakesOneId = (ids: readonly string[], mode: string | undefined, ctx: z.RefinementCtx) => {
  if (mode === 'one' && ids.length !== 1) ctx.addIssue({ code: 'custom', message: 'one mode requires exactly one id', path: ['mode'] });
};
const waitTimeoutSeconds = z.number().int().min(1).max(PEER_WAIT_MAX_SECONDS).default(PEER_WAIT_DEFAULT_SECONDS);

/** `cezar_wait`. The `pr` branch keeps the removed `cezar_wait_for_ci`'s bounds and default;
 *  it replaced kind `ci` (hearsay-tools/cezarion#1425). Kind `request` took `request_ids` from kind
 *  `worker`, and kind `peer` is new (hearsay-tools/cezarion#1995); a request wait is still stored
 *  as a `worker` entry with `requestIds`. */
const registrationFields = { operation_id: z.uuid().optional() };

export const squawkWaitRequestSchema = z.discriminatedUnion('kind', [
  ciWaitRequestSchema.extend({ kind: z.literal('pr'), ...registrationFields }).strict(),
  z.object({
    kind: z.literal('worker'), ...registrationFields,
    worker_ids: workerIdsSchema,
    mode: workerWaitModeSchema.optional(),
    timeout_seconds: waitTimeoutSeconds,
  }).strict().superRefine((request, ctx) => oneModeTakesOneId(request.worker_ids, request.mode, ctx)),
  z.object({
    kind: z.literal('request'), ...registrationFields,
    request_ids: workerIdsSchema,
    mode: workerWaitModeSchema.optional(),
    timeout_seconds: waitTimeoutSeconds,
  }).strict().superRefine((request, ctx) => oneModeTakesOneId(request.request_ids, request.mode, ctx)),
  z.object({
    kind: z.literal('peer'), ...registrationFields,
    peer_ids: workerIdsSchema,
    timeout_seconds: waitTimeoutSeconds,
  }).strict(),
  z.object({
    kind: z.literal('timer'), ...registrationFields,
    seconds: z.number().int().min(TIMER_MIN_SECONDS).max(TIMER_MAX_SECONDS),
    note: z.string().max(NOTE_MAX).optional(),
  }).strict(),
  z.object({
    kind: z.literal('process'), ...registrationFields,
    pid: pidSchema,
    exit_file: z.string().min(1).max(PROCESS_EXIT_FILE_MAX).optional(),
    timeout_seconds: z.number().int().min(1).max(PROCESS_TIMEOUT_MAX_SECONDS).default(PROCESS_TIMEOUT_DEFAULT_SECONDS),
    note: z.string().max(NOTE_MAX).optional(),
  }).strict(),
]);
export type SquawkWaitRequest = z.infer<typeof squawkWaitRequestSchema>;
/** What a caller may send: the defaults (`until`, `wake_on_conflict`, `timeout_seconds`) still unset. */
export type SquawkWaitRequestInput = z.input<typeof squawkWaitRequestSchema>;

export const squawkCancelWaitRequestSchema = z.object({ wait_id: z.uuid() }).strict();
export type SquawkCancelWaitRequest = z.infer<typeof squawkCancelWaitRequestSchema>;

const message = z.string().max(WAIT_MESSAGE_MAX);

const registrationAnswerFields = {
  operation_id: z.uuid().optional(),
};
export const squawkWaitAnswerSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true), ...registrationAnswerFields,
    effect: z.enum(['applied', 'unchanged']).optional(),
    deduplicated: z.boolean().optional(), replayed: z.boolean().optional(), wait_phase: z.enum([...waitPhaseSchema.options, 'unavailable']).optional(),
    wait_id: z.uuid(),
    /** The kind the call asked for: a `request` wait is stored as a `worker` entry. */
    kind: z.enum(['pr', 'timer', 'worker', 'request', 'process', 'peer']),
    deadline: z.iso.datetime(),
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT),
  }).strict(),
  z.object({
    ok: z.literal(false), ...registrationAnswerFields,
    effect: z.enum(['refused', 'unknown']).optional(),
    retained_wait: openWaitSchema.optional(),
    code: waitErrorCodeSchema,
    message,
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT).optional(),
  }).strict(),
]);
export type SquawkWaitAnswer = z.infer<typeof squawkWaitAnswerSchema>;

/**
 * `cezar_ask` (hearsay-tools/cezarion#1234): the user's answer, asked with a card. A question
 * without options is open, and the user types its answer. The wait it opens has no deadline.
 * `context` is required here (hearsay-tools/cezarion#1458), optional in every stored shape.
 */
export const squawkAskRequestSchema = askRequestSchema.extend({ context: askContextSchema });
export type SquawkAskRequest = z.infer<typeof squawkAskRequestSchema>;


export const squawkAskAnswerSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), wait_id: z.uuid(), open_waits: z.array(openWaitSchema).max(WAIT_LIMIT) }).strict(),
  z.object({
    ok: z.literal(false),
    code: askErrorCodeSchema,
    message,
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT).optional(),
  }).strict(),
]);
export type SquawkAskAnswer = z.infer<typeof squawkAskAnswerSchema>;

/** `already_resolved`: the result is owed and arrives with the next wake; cancelling is a no-op.
 *  `human_question`: the question already reached the user, so only their answer ends it. */
export const squawkCancelWaitAnswerSchema = z.discriminatedUnion('cancelled', [
  z.object({
    cancelled: z.literal(true),
    wait_id: z.uuid(),
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT),
  }).strict(),
  z.object({
    cancelled: z.literal(false),
    code: z.enum(['not_found', 'already_resolved', 'human_question', 'invalid_request', 'unavailable']),
    message,
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT).optional(),
  }).strict(),
]);
export type SquawkCancelWaitAnswer = z.infer<typeof squawkCancelWaitAnswerSchema>;

/** `cezar_done`: the run finishes when this turn ends. The summary becomes the closing note. */
export const squawkDoneRequestSchema = z.object({ summary: z.string().max(2000).optional() }).strict();
export type SquawkDoneRequest = z.infer<typeof squawkDoneRequestSchema>;

const doneAccepted = {
  ok: z.literal(true),
  finishes: z.literal('at_turn_end'),
  open_waits: z.array(openWaitSchema).max(WAIT_LIMIT),
};

/** An accepted done finishes the task, or, in a workflow step that is not the last, completes that
 *  step and starts `next_step`, named as the run's rail names it (hearsay-tools/cezarion#1620). */
export const squawkDoneAnswerSchema = z.discriminatedUnion('ok', [
  z.discriminatedUnion('completes', [
    z.object({ ...doneAccepted, completes: z.literal('task') }).strict(),
    z.object({ ...doneAccepted, completes: z.literal('step'), next_step: z.string().min(1) }).strict(),
  ]),
  z.object({
    ok: z.literal(false),
    code: doneErrorCodeSchema,
    message,
    /** The workers that block the finish, and why each one does. */
    workers: z.array(z.object({
      worker_id: z.string(),
      reason: z.enum(['outstanding', 'uncollected', 'question']),
    }).strict()).max(64).optional(),
    open_waits: z.array(openWaitSchema).max(WAIT_LIMIT).optional(),
    /** `input_pending` (hearsay-tools/squawk#2587): what the run still owes the agent. */
    owed: z.array(doneOwedInputSchema).max(64).optional(),
  }).strict(),
]);
export type SquawkDoneAnswer = z.infer<typeof squawkDoneAnswerSchema>;
