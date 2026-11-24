import { commandText } from '../home/command.ts';
import { WAIT_KINDS, waitPolicyForWait } from '../workflows/run/wait-kinds.ts';
import { createHash } from 'node:crypto';
import type { ConversationMessage, Wait, WorkerWaitEntry } from '@open-mercato/cezar-contract';
import { isUsageLimitHold } from '@open-mercato/cezar-contract/usage-limit-hold';
import type { RunEvent, RunRecord } from '../runs/store.ts';
import type { RunEventLog } from '../runs/ports.ts';
import { describeWait, isSquawkHumanWait } from '../workflows/waits.ts';
import { uuidFrom } from './questions.ts';
import { topLevelAssistantText } from './results.ts';

/** How much of the worker's last message a park notice quotes. */
export const PARK_NOTICE_EXCERPT_MAX = 1000;

/**
 * A parent waiting on a worker wakes only on its outcome or the wait's deadline, so a worker that
 * parks before finishing leaves its parent asleep (hearsay-tools/cezarion#1327). Squawk then tells
 * the parent itself, as a progress message from the worker: it wakes the parent and closes no
 * wait. The ID derives from the worker and the parent's wait, so one wait gets at most one notice
 * from each worker, and posting it again after a restart finds the same message.
 */
export function parkNoticeId(workerRunId: string, waitId: string): string {
  return uuidFrom(`worker-park:${workerRunId}:${waitId}`);
}

/** At most one hold notice per worker and parent wait: distinct from turn-park notices. */
export function holdNoticeId(workerRunId: string, waitId: string): string {
  return uuidFrom(`worker-hold:${workerRunId}:${waitId}`);
}

/** Whether the worker's own turn parked it (`parkReason`, ADR 0064), the one park that earns a
 *  notice (hearsay-tools/squawk#3502). A row saved before the fact reads as a turn's park unless it
 *  is a usage-limit hold. */
export function parkedByTurn(run: Pick<RunRecord, 'status' | 'autoResumeAt' | 'parkReason'>): boolean {
  return (run.parkReason ?? (isUsageLimitHold(run) ? 'hold' : 'turn')) === 'turn';
}

/** The parent's first open worker wait that selects the worker, by its ID or by a request to
 *  it, and holds no notice with `noticeIdFor` yet. */
export function parkNoticeWait(
  workerRunId: string,
  waits: readonly Wait[],
  findMessage: (id: string) => ConversationMessage | undefined,
  noticeIdFor: (workerId: string, waitId: string) => string = parkNoticeId,
): WorkerWaitEntry | undefined {
  const selects = (wait: WorkerWaitEntry) => wait.workerIds ? wait.workerIds.includes(workerRunId)
    : (wait.requestIds ?? []).some(id => findMessage(id)?.recipientRunId === workerRunId);
  const noticed = (wait: WorkerWaitEntry) => findMessage(noticeIdFor(workerRunId, wait.id)) !== undefined;
  return WAIT_KINDS.worker.selectOpen(waits).find(wait => selects(wait) && !noticed(wait));
}

/** Whether the worker sent its parent a message since `since`, the start of its parking turn. A
 *  turn that already said something needs no notice. */
export function messagedParentSince(messages: readonly ConversationMessage[], workerRunId: string, parentRunId: string, since: string | undefined): boolean {
  return since !== undefined && messages.some(message => message.senderRunId === workerRunId && message.recipientRunId === parentRunId && message.createdAt >= since);
}

/** The turn the worker parked in: when it started, and its last top-level assistant text. An
 *  event log without a `turn.started` gives no start, and the whole log is that turn. */
export function parkingTurn(events: readonly RunEvent[]): { startedAt?: string; text?: string } {
  let text: string | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === 'turn.started') return { startedAt: event.ts, ...(text === undefined ? {} : { text }) };
    const said = text === undefined ? topLevelAssistantText(event) : undefined;
    if (said?.trim()) text = said;
  }
  return text === undefined ? {} : { text };
}

/** The worker's own words, without Squawk's control lines, cut to `PARK_NOTICE_EXCERPT_MAX`. */
export function parkNoticeExcerpt(text: string): string | undefined {
  const prose = text.split('\n').filter(line => !line.trim().startsWith('CEZ:')).join('\n').trim();
  if (!prose) return undefined;
  return prose.length > PARK_NOTICE_EXCERPT_MAX ? `${prose.slice(0, PARK_NOTICE_EXCERPT_MAX)}…` : prose;
}

/** What the parent reads: who parked, what it waits on, what it last said, and what to do next. */
export function formatParkNoticeText(input: { workerRunId: string; waitId: string; waits: readonly Wait[]; lastText?: string }): string {
  // A worker parked on a question gets no notice; its question reaches the parent instead.
  const open = input.waits.filter(wait => wait.phase === 'open' && !waitPolicyForWait(wait).userAnswers && !isSquawkHumanWait(wait));
  const excerpt = input.lastText === undefined ? undefined : parkNoticeExcerpt(input.lastText);
  return [
    `Squawk notice: your worker ${input.workerRunId} parked before finishing. Your wait ${input.waitId} stays open; this message closes no wait.`,
    open.length ? `It waits on: ${open.map(describeWait).join('; ')}.` : 'It has no open wait: it waits for a message from you.',
    ...(excerpt === undefined ? [] : ['Its last message:', excerpt]),
    commandText(`Check it with cez worker inspect ${input.workerRunId}, or instruct it with cez message request ${input.workerRunId} '<instruction>' --id <new-message-UUID>.`),
  ].join('\n');
}

export function parkNoticeMessage(input: {
  workerRunId: string; parentRunId: string; waitId: string; waits: readonly Wait[]; lastText?: string; now: string; redact(text: string): string;
}): ConversationMessage {
  const id = parkNoticeId(input.workerRunId, input.waitId);
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ senderRunId: input.workerRunId, recipientRunId: input.parentRunId, parkNotice: input.waitId }))
    .digest('hex');
  return { id, senderRunId: input.workerRunId, recipientRunId: input.parentRunId, kind: 'progress',
    text: input.redact(formatParkNoticeText(input)), createdAt: input.now, requestHash, state: 'accepted' };
}

/** What the supervisor reads when a worker enters a usage-limit or provider-error hold. */
export function formatHoldNoticeText(input: {
  workerRunId: string; waitId: string; reason: 'usage-limit' | 'provider-error'; resumeAt: string;
  error?: string; runner?: string; model?: string; effort?: string;
}): string {
  const kind = input.reason === 'provider-error' ? 'provider error' : 'usage limit';
  const detail = input.error ? parkNoticeExcerpt(input.error) : undefined;
  const settings = [
    ...(input.runner ? [`runner: ${input.runner}`] : []),
    ...(input.model ? [`model: ${input.model}`] : []),
    ...(input.effort ? [`effort: ${input.effort}`] : []),
  ];
  return [
    `Squawk notice: your worker ${input.workerRunId} hit a ${kind} and is on hold until ${input.resumeAt}. Your wait ${input.waitId} stays open; this message closes no wait.`,
    ...(detail === undefined ? [] : [`Error: ${detail}`]),
    ...(settings.length ? [`Current settings: ${settings.join(', ')}.`] : []),
    commandText(`Wait for automatic resume, inspect with cez worker inspect ${input.workerRunId}, or resume now with cez worker resume ${input.workerRunId} '<instruction>' --id <new-message-UUID> [--model <model>] [--effort <level>].`),
  ].join('\n');
}

export function holdNoticeMessage(input: {
  workerRunId: string; parentRunId: string; waitId: string; reason: 'usage-limit' | 'provider-error'; resumeAt: string;
  error?: string; runner?: string; model?: string; effort?: string; now: string; redact(text: string): string;
}): ConversationMessage {
  const id = holdNoticeId(input.workerRunId, input.waitId);
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ senderRunId: input.workerRunId, recipientRunId: input.parentRunId, holdNotice: input.waitId }))
    .digest('hex');
  return { id, senderRunId: input.workerRunId, recipientRunId: input.parentRunId, kind: 'progress',
    text: input.redact(formatHoldNoticeText(input)), createdAt: input.now, requestHash, state: 'accepted' };
}

/** A peer already took the notice's deterministic ID in the parent conversation (hearsay-tools/cezarion#1990
 *  review): no notice can be sent for this wait, and the worker's log says so once. */
export function parkNoticeIdInUse(store: { readonly eventLog: RunEventLog }, workerId: string, waitId: string): void {
  const projectionId = `park-notice-id-in-use:${waitId}`;
  if (store.eventLog.hasProjection(workerId, projectionId)) return;
  store.eventLog.appendEvent(workerId, { type: 'note', tone: 'warning', projectionId, message: 'Parked, but the park notice ID is already in use in the parent conversation: no park notice was sent.' });
}
