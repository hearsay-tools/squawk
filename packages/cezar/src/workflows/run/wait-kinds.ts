import { waitKindRow, registeredWaitKinds, registerWaitKind, waitKindForWait, type WaitLifecycle, type WaitRegistryPort, type WaitWatchContext } from './wait-kind-registry.ts';
import { builtInWaitInputs } from './wait-input-descriptors.ts';
import type { WaitResult, resolvedWaits } from '../waits.ts';
import type { ProcessWaitResult, SubagentWaitResult } from '@open-mercato/cezar-contract';
import { runningSubagents } from '@open-mercato/cezar-contract/waits';
import { SUBAGENT_WAIT_DEADLINE_SECONDS, TIMER_MIN_SECONDS, TIMER_MAX_SECONDS } from '@open-mercato/cezar-contract/wait-limits';
import { randomUUID } from 'node:crypto';
import type { TimerWaitEntry, PrWaitEntry, ProcessWaitEntry, PeerWaitEntry, WorkerWaitEntry, DeadlinedWorkerWaitEntry, HumanWaitEntry, BuiltInSquawkWaitRequestInput as SquawkWaitRequestInput, WaitVia, SubagentWaitEntry, SubagentChild } from '@open-mercato/cezar-contract';
import type { Wait, WaitPhase, BuiltInSquawkWaitRequest as SquawkWaitRequest } from '@open-mercato/cezar-contract';
import type { WorkerWaitRequest } from '@open-mercato/cezar-contract/delegation';
import type { FiredBy } from '../run-states.ts';
import type { RegistrationIdentity } from './wait-registration.ts';
import { isSquawkHumanWait, isUserAnsweredKind, SUBAGENT_SUPERSEDED_RESULT, waitInputId } from '../../runs/wait-helpers.ts';

/** Each wait kind: its deadline, whether it keeps a slot while it is the top wait, who resolves it. */
export type WaitKindSpec = {
  deadline: 'required' | 'agent-only' | 'none';
  keepsSlot: boolean;
  resolves: readonly { trigger: string; firedBy: FiredBy }[];
  cancels: readonly string[];
  humanOnly?: string;
};

/** What a monitoring timer (Claude's `ScheduleWakeup`, or a saved monitoring-line timer) says when it fires. */
export const MONITORING_WAKE_NUDGE =
  'Re-check the downstream work you were monitoring. Continue toward the task goal. When the goal is complete and verified, call cezar_done. If the watched work is still pending, call cezar_wait again. If you need the user, call cezar_ask.';

export const ENDS_WAITS = ['cezar_cancel_wait', 'a done is accepted', 'Stop', 'Finish', 'delete'] as const;

type RegistrationRequest = {
  timer: Extract<SquawkWaitRequest, { kind: 'timer' }>;
  process: Extract<SquawkWaitRequest, { kind: 'process' }>;
};
/** `handler`: the registered row's own `registerRequest` serves the request. */
type RegistrationPath = { pr: 'handler'; timer: 'timer'; process: 'process'; peer: 'handler'; worker: 'handler'; human: 'none'; subagent: 'none'; plugin: 'none' };

/** The targets a worker or request wait records at registration. */
export type WorkerTarget = Pick<WorkerWaitEntry, 'workerIds' | 'requestIds' | 'outcomes' | 'requestOutcomes' | 'revisions'>;
/** A worker or request wait the CLI or `cezar_wait` names. */
export type WorkerListRequest = { workerIds?: string[]; requestIds?: string[] | undefined; mode?: WorkerWaitRequest['mode']; timeoutSeconds: number };
type WorkerListVia = 'cezar_wait' | 'cez-worker-wait';
type PeerListVia = 'cezar_wait' | 'cez-message-wait';
type PeerRequest = { peerIds: string[]; timeoutSeconds: number };

export type BuiltInWaitKindRow<K extends Wait['kind']> = WaitKindSpec & {
  is: (wait: Wait) => wait is Extract<Wait, { kind: K }>;
  select: (waits: readonly Wait[]) => Extract<Wait, { kind: K }>[];
  selectOpen: (waits: readonly Wait[]) => Extract<Wait, { kind: K }>[];
  capNote: (wait: Wait, maxAutoContinues: number) => string;
  deliveryLabel: (wait: Wait) => readonly { priority: number; text: string }[];
  sessionlessPrompt: { priority: number; text: string };
  summary: (wait: Wait) => string;
  resultText: (wait: Wait, workerStatus: (workerId: string) => string) => string;
  footerItem: (wait: Wait) => string;
  footerKinds: readonly { order: number; text: string }[];
  resolve: (latest: Wait, result: WaitResult | undefined, observed: WorkerWaitEntry | undefined, resolvedAt: string) => Wait;
  inputId: (wait: Wait) => string;
  answerKind: (wait: Wait) => Exclude<Wait['kind'], 'human' | 'subagent'> | 'request' | undefined;
  hasDeadline: (wait: Wait) => boolean;
  registration: RegistrationPath[K];
  requestKinds: readonly SquawkWaitRequest['kind'][];
  delegation: boolean;

  entry: {
    pr: (...args: never[]) => PrWaitEntry; timer: typeof timerWaitEntry; process: typeof processWaitEntry;
    peer: (request: PeerRequest, via: PeerListVia, turnId: () => string) => PeerWaitEntry;
    worker: (request: Pick<WorkerListRequest, 'mode' | 'timeoutSeconds'>, via: WorkerListVia, now: number, turnId: string, target: WorkerTarget) => DeadlinedWorkerWaitEntry;
    human: typeof askWaitEntry; subagent: typeof subagentWaitEntry; plugin: undefined;
  }[K];

  duplicate: (wait: Wait, request: SquawkWaitRequestInput, turnId: string, context: { startToken?: string; exitFile?: string }) => boolean;
  canonicalize: (request: SquawkWaitRequest) => void;
  repeatTimeout: (wait: Wait) => number | undefined;
  requestedTimeout: (request: SquawkWaitRequest) => number | undefined;

  chargesWake: K extends 'process' | 'peer' | 'subagent' ? (wait: Wait) => boolean : boolean;
  /** The result ends the wait without what the agent waited for: a failed, cancelled or timed-out
   *  check, process, worker, request, peer or subagent. Such a result withdraws an accepted
   *  `cezar_done`; a success keeps it (hearsay-tools/squawk#2587). A human wait has no such
   *  result: the user's answer is a human message. */
  failedResult: (wait: Wait) => boolean;
  refusesSpentBudget: boolean;
  holdsSession: boolean;
  cancellable: K extends 'human' ? 'unshown' : true;
  timersDisabled: K extends 'timer' | 'process' ? true : false;
  userAnswers: boolean;
  holdsConversationInput: boolean;
  runnerResumeCancels: readonly WaitPhase[];
} & {
  pr: {};
  process: {};
  plugin: {};
  subagent: { supersededResult: { reason: 'superseded' } };
  worker: {
    completionEntry: (turnId: string, target: WorkerTarget) => WorkerWaitEntry;
    duplicateWorker: typeof identicalWorkerWait;
    workerListTarget: (request: Extract<SquawkWaitRequest, { kind: 'worker' | 'request' }>) => {
      workerIds?: string[]; requestIds?: string[]; mode?: 'one' | 'any' | 'all'; timeoutSeconds: number;
    };
    /** `cez worker wait`, `cez message wait --request` and `cezar_wait`'s worker and request kinds. */
    registerList: (port: WaitRegistryPort, runId: string, request: WorkerListRequest, via: WorkerListVia, registration?: RegistrationIdentity) => DeadlinedWorkerWaitEntry;
    /** Squawk's own wait on the workers or requests that block a done. */
    registerCompletion: (port: WaitRegistryPort, runId: string, workerIds: string[], requestIds?: string[]) => WorkerWaitEntry | undefined;
  };
  human: {
    aliasEntry: typeof humanAliasEntry;
    recoveredEntry: typeof recoveredAskEntry;
    aliasSource: (via: WaitVia) => 'agent' | 'cezar';
  };
  timer: {
    monitoring: (wait: Wait) => boolean;
    monitoringNudge: string;
    monitoringEntry: typeof monitoringTimerEntry;
    duplicateMonitoring: (waits: readonly Wait[], via: WaitVia) => boolean;
  };
  peer: {
    duplicatePeer: typeof identicalPeerWait;
    /** `cez message wait --peer` and `cezar_wait`'s peer kind. */
    registerPeer: (port: WaitRegistryPort, runId: string, request: PeerRequest, via: PeerListVia, registration?: RegistrationIdentity) => PeerWaitEntry;
    /** `cez message cancel-wait` on a peer wait. */
    cancelPeer: (port: WaitRegistryPort, runId: string, waitId: string) => PeerWaitEntry;
  };
}[K];

/** Typed selectors share the stored kind's list order and phase rule. */
export function waitSelectors<K extends Wait['kind']>(kind: K) {
  const is = (wait: Wait): wait is Extract<Wait, { kind: K }> => wait.kind === kind;
  const select = (waits: readonly Wait[]) => waits.filter(is);
  const selectOpen = (waits: readonly Wait[]) => select(waits).filter(wait => wait.phase === 'open');
  return { is, select, selectOpen };
}

type CoreWaitKind = 'timer' | 'process' | 'subagent' | 'plugin' | 'human';

export const BUILT_IN_WAIT_ROWS: { readonly [K in CoreWaitKind]: BuiltInWaitKindRow<K> } = {
  timer: {
    ...waitSelectors('timer'),
    capNote: (wait, maxAutoContinues) => `automatic ${WAIT_KINDS.timer.monitoring(wait) ? 'monitoring' : 'timer'} wake-up cap reached (${maxAutoContinues}); timer ${wait.id} cancelled`,
    deliveryLabel: wait => [{ priority: WAIT_KINDS.timer.monitoring(wait) ? 0 : 1, text: WAIT_KINDS.timer.monitoring(wait) ? 'monitoring' : 'timer' }],
    sessionlessPrompt: { priority: 3, text: `Resume to receive the queued timer result. End this opening turn so Squawk can deliver it.` },
    monitoring: wait => wait.kind === 'timer' && (wait.via === 'monitoring-line' || wait.via === 'schedule-wakeup'),
    monitoringNudge: MONITORING_WAKE_NUDGE,
    summary: wait => { const timer = wait as TimerWaitEntry; return clipWaitSummary(timer.note === undefined ? 'timer' : `timer: ${timer.note}`); },
    resultText: wait => {
      if (WAIT_KINDS.timer.monitoring(wait)) return WAIT_KINDS.timer.monitoringNudge;
      const timer = wait as TimerWaitEntry;
      const fired = `Timer ${timer.id} fired${timer.note === undefined ? '' : `: ${timer.note}`}.`;
      return `${fired} Continue toward the task goal; register another wait if you are still waiting.`;
    },
    footerItem: wait => { const timer = wait as TimerWaitEntry; return `timer ${timer.id} at ${timer.deadline}${timer.note === undefined ? '' : ` (${timer.note})`}`; },
    footerKinds: [{ order: 6, text: 'timer' }],
    resolve: (latest, _result, _observed, resolvedAt) => ({ ...latest, phase: 'resolved', resolvedAt }),
    inputId: waitInputId,
    entry: timerWaitEntry,
    monitoringEntry: monitoringTimerEntry,
    duplicate: (wait, request, turnId) => request.kind === 'timer' && wait.kind === 'timer' && wait.seconds === request.seconds && wait.note === request.note && wait.turnId === turnId,
    canonicalize: () => {},
    repeatTimeout: wait => 'seconds' in wait ? wait.seconds : undefined,
    requestedTimeout: () => undefined,
    duplicateMonitoring: (waits, via) => waits.some(wait => wait.phase === 'open' && wait.kind === 'timer' && wait.via === via),
    answerKind: () => 'timer',
    hasDeadline: () => true,
    registration: 'timer', requestKinds: ['timer'],
    delegation: false,
    userAnswers: isUserAnsweredKind('timer'), holdsConversationInput: false, runnerResumeCancels: ['open'],
    chargesWake: true, refusesSpentBudget: true, holdsSession: false, cancellable: true, timersDisabled: true,
    failedResult: () => false,
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the wake budget is spent at its deadline'], resolves: [
    { trigger: 'the deadline (60 to 7,200 s)', firedBy: 'timer' },
  ] },
  process: {
    ...waitSelectors('process'),
    capNote: (wait, maxAutoContinues) => `automatic ${wait.kind} wake-up cap reached (${maxAutoContinues}); ${wait.kind} wait ${wait.id} cancelled`,
    deliveryLabel: () => [{ priority: 2, text: 'process' }],
    sessionlessPrompt: { priority: 3, text: `Resume to receive the queued timer result. End this opening turn so Squawk can deliver it.` },
    summary: wait => { const process = wait as ProcessWaitEntry; return clipWaitSummary(process.note === undefined ? `process ${process.pid}` : `process ${process.pid}: ${process.note}`); },
    resultText: wait => processWaitResultText(wait as ProcessWaitEntry),
    footerItem: wait => { const process = wait as ProcessWaitEntry; return `process wait ${process.id} on PID ${process.pid}${process.note === undefined ? '' : ` (${process.note})`}, deadline ${process.deadline}`; },
    footerKinds: [{ order: 4, text: 'process' }],
    resolve: (latest, result, _observed, resolvedAt) => ({ ...latest as ProcessWaitEntry, phase: 'resolved', resolvedAt, result: (result as ProcessWaitResult | undefined) ?? { outcome: 'deadline', observedAt: resolvedAt } }),
    inputId: waitInputId,
    entry: processWaitEntry,
    duplicate: (wait, request, _turnId, context) => request.kind === 'process' && wait.kind === 'process' && wait.pid === request.pid && wait.startToken === context.startToken && wait.exitFile === context.exitFile,
    canonicalize: () => {},
    repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
    requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
    answerKind: () => 'process',
    hasDeadline: () => true,
    registration: 'process', requestKinds: ['process'],
    delegation: false,
    userAnswers: isUserAnsweredKind('process'), holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: wait => (wait as ProcessWaitEntry).result?.outcome !== 'deadline', refusesSpentBudget: true, holdsSession: false, cancellable: true, timersDisabled: true,
    failedResult: wait => { const result = (wait as ProcessWaitEntry).result; return result === undefined || result.outcome === 'deadline' || result.outcome === 'error' || (result.exitCode ?? 0) !== 0; },
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the process is not signalled'], resolves: [
    { trigger: 'the exit file, the process gone, the deadline (up to 7,200 s) or a probe error, polled every 5 s', firedBy: 'watcher' },
  ] },
  subagent: {
    ...waitSelectors('subagent'),
    capNote: (wait, maxAutoContinues) => `automatic ${wait.kind} wake-up cap reached (${maxAutoContinues}); ${wait.kind} wait ${wait.id} cancelled`,
    deliveryLabel: () => [],
    sessionlessPrompt: { priority: 2, text: `Resume to receive the queued subagent wait result: your native subagents are no longer running. End this opening turn so Squawk can deliver it.` },
    summary: wait => clipWaitSummary(`subagent wait on ${subagentPhrase(wait as SubagentWaitEntry)}`),
    resultText: wait => subagentWaitResultText(wait as SubagentWaitEntry),
    footerItem: wait => { const subagent = wait as SubagentWaitEntry; return `subagent wait ${subagent.id} on ${subagentPhrase(subagent)}, deadline ${subagent.deadline}`; },
    footerKinds: [{ order: 5, text: 'subagent' }],
    supersededResult: SUBAGENT_SUPERSEDED_RESULT,
    resolve: (latest, result, _observed, resolvedAt) => ({ ...latest as SubagentWaitEntry, phase: 'resolved', resolvedAt, result: (result as SubagentWaitResult | undefined) ?? { reason: 'timeout' } }),
    inputId: waitInputId,
    entry: subagentWaitEntry,
    duplicate: () => false,
    canonicalize: () => {},
    repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
    requestedTimeout: () => undefined,
    answerKind: () => undefined,
    hasDeadline: () => true,
    registration: 'none', requestKinds: [],
    delegation: false,
    userAnswers: isUserAnsweredKind('subagent'), holdsConversationInput: false, runnerResumeCancels: ['open', 'resolved'],
    chargesWake: wait => (wait as SubagentWaitEntry).result?.reason === 'timeout', refusesSpentBudget: false, holdsSession: true, cancellable: true, timersDisabled: false,
    failedResult: wait => ['timeout', 'interrupted'].includes((wait as SubagentWaitEntry).result?.reason ?? ''),
    deadline: 'required', keepsSlot: true, cancels: [...ENDS_WAITS, 'the runner starts a parent turn itself', 'every child already ended at the turn end', 'the deadline with the wake budget spent'], resolves: [
    { trigger: 'every child ended and no parent turn started within 15 s', firedBy: 'runner' },
    { trigger: 'the deadline, 30 minutes after the last child event', firedBy: 'timer' },
    { trigger: 'a restart or a lost session: the children stopped', firedBy: 'recovery' },
  ] },
  // Stored plugin rows remain readable before B2 supplies registered watch adapters.
  plugin: {
    ...waitSelectors('plugin'),
    capNote: wait => `plugin wait ${wait.id} cancelled`,
    deliveryLabel: () => [],
    sessionlessPrompt: { priority: 3, text: 'Resume to receive the queued wait result. End this opening turn so Squawk can deliver it.' },
    summary: wait => (wait as Extract<Wait, { kind: 'plugin' }>).summary,
    resultText: wait => `Plugin wait ${wait.id} ended. External data follows: ${JSON.stringify((wait as Extract<Wait, { kind: 'plugin' }>).result)}.`,
    footerItem: wait => { const plugin = wait as Extract<Wait, { kind: 'plugin' }>; return `${plugin.summary} (${plugin.id})${plugin.deadline ? `, deadline ${plugin.deadline}` : ''}`; },
    footerKinds: [],
    resolve: (latest, result, _observed, resolvedAt) => ({ ...latest as Extract<Wait, { kind: 'plugin' }>, phase: 'resolved', resolvedAt, ...(result === undefined ? {} : { result: result as Record<string, unknown> }) }),
    inputId: waitInputId,
    entry: undefined,
    duplicate: () => false, canonicalize: () => {},
    repeatTimeout: () => undefined, requestedTimeout: () => undefined,
    answerKind: () => undefined, hasDeadline: wait => 'deadline' in wait && wait.deadline !== undefined,
    registration: 'none', requestKinds: [], delegation: false,
    userAnswers: false, holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
    failedResult: () => false,
    deadline: 'none', keepsSlot: true, humanOnly: 'Without a registered adapter the stored wait remains open until cancelled.', cancels: ENDS_WAITS, resolves: [],
  },

  human: {
    ...waitSelectors('human'),
    capNote: (wait, maxAutoContinues) => `automatic ${WAIT_KINDS.timer.monitoring(wait) ? 'monitoring' : 'timer'} wake-up cap reached (${maxAutoContinues}); timer ${wait.id} cancelled`,
    deliveryLabel: () => [],
    sessionlessPrompt: { priority: 3, text: `Resume to receive the queued timer result. End this opening turn so Squawk can deliver it.` },
    summary: wait => { const first = (wait as HumanWaitEntry).questions?.[0]?.question; return first === undefined ? 'human question' : clipWaitSummary(`human: ${first}`); },
    // The user's own message is a human wait's result; this text is never its delivery.
    resultText: wait => `Human wait ${wait.id} ended.`,
    footerItem: wait => `your question ${wait.id} to the user`,
    footerKinds: [],
    resolve: (latest, _result, _observed, resolvedAt) => ({ ...latest, phase: 'resolved', resolvedAt }),
    inputId: waitInputId,
    entry: askWaitEntry,
    aliasEntry: humanAliasEntry,
    recoveredEntry: recoveredAskEntry,
    aliasSource: via => via === 'budget' || via === 'no-wait' || via === 'completion' ? 'cezar' : 'agent',
    duplicate: () => false,
    canonicalize: () => {},
    repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
    requestedTimeout: () => undefined,
    answerKind: () => undefined,
    hasDeadline: () => false,
    registration: 'none', requestKinds: [],
    delegation: false,
    userAnswers: isUserAnsweredKind('human'), holdsConversationInput: false, runnerResumeCancels: [],
    chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: 'unshown', timersDisabled: false,
    // The user's answer is a human message: its own event withdraws a done (acceptedDoneHolds).
    failedResult: () => false,
    deadline: 'none', keepsSlot: false, humanOnly: 'The question is the user\'s gate.',
    cancels: [`the agent's own wait replaces Squawk's`, 'a done in the same turn', 'Stop', 'Finish', 'an authored step timeoutMs'],
    resolves: [{ trigger: 'an answer; the parent\'s for a routed worker question', firedBy: 'human' }] },
};


export function timerWaitEntry(parsed: Extract<SquawkWaitRequest, { kind: 'timer' }>, via: WaitVia, turnId: string, now: number) {
  const wait: TimerWaitEntry = { id: randomUUID(), kind: 'timer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
        deadline: new Date(now + parsed.seconds * 1000).toISOString(), phase: 'open', turnId, seconds: parsed.seconds,
        ...(parsed.note === undefined ? {} : { note: parsed.note }) };
  return wait;
}


export function processWaitEntry(request: Extract<SquawkWaitRequest, { kind: 'process' }>, via: WaitVia, turnId: string, now: number, startToken: string | undefined, exitFile: string | undefined) {
  const wait: ProcessWaitEntry = { id: randomUUID(), kind: 'process', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + request.timeout_seconds * 1000).toISOString(), phase: 'open', turnId, timeoutSeconds: request.timeout_seconds,
      pid: request.pid, ...(startToken === undefined ? {} : { startToken }), ...(exitFile === undefined ? {} : { exitFile }),
      ...(request.note === undefined ? {} : { note: request.note }) };
  return wait;
}

/**
 * The open wait a registration repeats, if any. PR: the same PR, target and conflict switch, whatever
 * its timeout (hearsay-tools/cezarion#1425). Timer: the
 * same seconds and note, registered in the same turn (a later turn asking again means a new check).
 * Process: the same PID, start token and resolved exit file in `context`, whatever its timeout or
 * note (hearsay-tools/cezarion#1446).
 */
export function identicalWait(waits: readonly Wait[], request: SquawkWaitRequestInput, turnId: string,
  context: { startToken?: string; exitFile?: string } = {}): PrWaitEntry | TimerWaitEntry | ProcessWaitEntry | undefined {
  const row = waitRequestRow(request.kind);
  if (row.delegation) return undefined;
  return waits.find((wait): wait is PrWaitEntry | TimerWaitEntry | ProcessWaitEntry =>
    wait.phase === 'open' && row.duplicate(wait, request, turnId, context));
}

/**
 * The open worker wait a registration repeats (hearsay-tools/cezarion#1235): the same target kind,
 * the same ids in any order and the same mode (`any` when omitted), whatever its timeout.
 */
export function identicalWorkerWait(waits: readonly Wait[], target: { workerIds?: readonly string[]; requestIds?: readonly string[] | undefined; mode?: string | undefined }): WorkerWaitEntry | undefined {
  const key = (ids: readonly string[] | undefined) => ids ? [...ids].sort().join(',') : undefined;
  return waits.find((wait): wait is WorkerWaitEntry => wait.kind === 'worker' && wait.phase === 'open' &&
    key(wait.workerIds) === key(target.workerIds) && key(wait.requestIds) === key(target.requestIds) && (wait.mode ?? 'any') === (target.mode ?? 'any'));
}

/** The open peer wait a registration repeats (hearsay-tools/cezarion#1995): the same peers in any
 *  order, whatever its timeout. */
export function identicalPeerWait(waits: readonly Wait[], peerIds: readonly string[]): PeerWaitEntry | undefined {
  const key = (ids: readonly string[]) => [...ids].sort().join(',');
  return waits.find((wait): wait is PeerWaitEntry => wait.kind === 'peer' && wait.phase === 'open' && key(wait.peerIds) === key(peerIds));
}

/** The stored row that serves a tool request kind, including request waits in the worker row. */
export function waitRequestRow(kind: string) {
  const row = registeredWaitKinds().find(row => row.requestKinds.some(requestKind => requestKind === kind));
  if (!row) throw Object.assign(new Error(`no wait row registers ${kind}`), { code: 'invalid_request' });
  return row;
}

function askWaitEntry(turnId: string): HumanWaitEntry {
  return { id: randomUUID(), kind: 'human', source: 'agent', via: 'cezar_ask', registeredAt: new Date().toISOString(), phase: 'open', turnId };
}

function humanAliasEntry(source: 'agent' | 'cezar', via: WaitVia, turnId: string, card: Pick<HumanWaitEntry, 'questions' | 'context'> | undefined): HumanWaitEntry {
  const wait: HumanWaitEntry = { id: randomUUID(), kind: 'human', source, via,
      registeredAt: new Date().toISOString(), phase: 'open', turnId, ...card };
  return wait;
}

function recoveredAskEntry(askSeq: number): HumanWaitEntry {
  return { id: randomUUID(), kind: 'human', source: 'agent', via: 'ask-line', registeredAt: new Date().toISOString(), phase: 'open', turnId: 'recovered', askSeq };
}

function subagentWaitEntry(turnId: string, deadline: string, children: SubagentChild[]): SubagentWaitEntry {
  const wait: SubagentWaitEntry = { id: randomUUID(), kind: 'subagent', source: 'cezar', via: 'native-subagents', registeredAt: new Date().toISOString(),
      phase: 'open', turnId, deadline, children };
  return wait;
}

function monitoringTimerEntry(via: WaitVia, now: number, delay: number | undefined, minutes: number, turnId: string): TimerWaitEntry {
  // `seconds` is the record's bound; the live-workers deadline is the interval itself (tests run it sub-minute).
  const wait: TimerWaitEntry = { id: randomUUID(), kind: 'timer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + (delay === undefined ? minutes * 60_000 : delay * 1000)).toISOString(), phase: 'open', turnId,
      seconds: delay ?? Math.min(TIMER_MAX_SECONDS, Math.max(TIMER_MIN_SECONDS, Math.round(minutes * 60))),
      ...(via === 'monitoring-line' ? { note: 'Opened while workers run.' } : {}) };
  return wait;
}

const SUMMARY_MAX = 256;
const SUBAGENT_DEADLINE_MINUTES = SUBAGENT_WAIT_DEADLINE_SECONDS / 60;

/** Monitoring timers: the timers Squawk opens for live workers (`monitoring-line`, also the via of
 *  saved `CEZ:MONITORING` timers) and `ScheduleWakeup`. */
export function isMonitoringTimer(wait: Wait): boolean {
  return WAIT_KINDS.timer.monitoring(wait);
}

export { isSquawkHumanWait };

/** A summary clipped to the stored bound. */
export function clipWaitSummary(text: string, max = SUMMARY_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The children a subagent wait still waits on, as its summary and footer name them. */
function subagentPhrase(wait: SubagentWaitEntry): string {
  const n = runningSubagents(wait);
  return `${n} native ${n === 1 ? 'subagent' : 'subagents'}`;
}

/** The lifecycle input a resolved wait delivers. Its id is the wait's, so duplicates keep it.
 *  `workerStatus` names a worker's current status for a worker wait's text. */
export function waitResultText(wait: Wait, { workerStatus = () => 'unavailable' }: { workerStatus?: (workerId: string) => string } = {}): string {
  return waitPolicyForWait(wait).resultText(wait, workerStatus);
}

/** Whether a process wait found no process at its PID when it was registered: it then carries no
 *  start identity and was settled by registration's own check, at the registration instant. */
export function processNotRunningAtRegistration(wait: Pick<ProcessWaitEntry, 'startToken' | 'registeredAt' | 'result'>): boolean {
  return wait.result?.outcome === 'exited' && wait.startToken === undefined && wait.result.observedAt === wait.registeredAt;
}

/** A process wait's result (hearsay-tools/cezarion#1446). Only the outcome and an integer exit code
 *  come from Squawk; the agent reads the command's own output with its tools. */
function processWaitResultText(wait: ProcessWaitEntry): string {
  const head = `Process wait ${wait.id} for PID ${wait.pid}${wait.note === undefined ? '' : ` (${wait.note})`}`;
  const read = "Read the command's output with your own tools.";
  const result = wait.result;
  if (result?.outcome === 'exit_file') return `${head}: ${result.exitCode === undefined ? 'exit file present, not an exit code' : `exited with code ${result.exitCode}`}. ${read}`;
  if (result?.outcome === 'exited') {
    // hearsay-tools/cezarion#3097: a launcher's PID (`setsid … & echo $!`) is gone before the wait
    // opens while the command still runs, and read as a finished command it was started again.
    if (processNotRunningAtRegistration(wait)) return `${head}: PID ${wait.pid} was not running when this wait was registered. If the command should still run, this is not its PID: find the command before you start it again. ${read}`;
    return `${head}: exited, code unknown. ${read}`;
  }
  if (result?.outcome === 'error') return `${head}: could not be checked (${result.diagnostic ?? 'unknown error'}). Check it with your own tools.`;
  return `${head}: still running at the deadline. Register another wait if you still need it.`;
}

/** A subagent wait's result (hearsay-tools/cezarion#2431). The children's own output stays with the
 *  runner: the agent reads it with its tools. */
export function subagentWaitResultText(wait: SubagentWaitEntry): string {
  const ended = wait.children.filter(child => child.status !== 'running');
  const outcomes = ended.map(child => `${child.id} ${child.status}`).join(', ');
  const head = `Subagent wait ${wait.id}`;
  const reason = wait.result?.reason;
  if (reason === 'interrupted') {
    const n = wait.children.filter(child => child.status === 'running').length;
    return `${head}: Squawk restarted, and the ${n} native ${n === 1 ? 'subagent' : 'subagents'} still running in your last session stopped with it. Check what each one finished before it stopped, and start again any work it did not finish.`;
  }
  if (reason === 'timeout') return `${head}: no subagent event for ${Math.round(SUBAGENT_DEADLINE_MINUTES)} minutes; ${subagentPhrase(wait)} still running${outcomes ? ` (ended: ${outcomes})` : ''}. Check them, then end your turn to keep waiting, or continue toward the task goal.`;
  return `${head}: every native subagent ended (${outcomes}). Read their results and continue toward the task goal.`;
}

/** One wait as the footer names it. A worker's park notice names its waits the same way
 *  (hearsay-tools/cezarion#1327). */
export function describeWait(wait: Wait): string {
  return waitPolicyForWait(wait).footerItem(wait);
}

/** The footer a delivered turn ends with: every wait still open, or undefined when none is. The
 *  user's reply settles a question and a question the user saw cannot be cancelled, so cancel is
 *  offered only for CI, worker, request, peer, process and subagent waits and timers (hearsay-tools/cezarion#1234). */
export function openWaitsFooter(waits: readonly Wait[]): string | undefined {
  const open = waits.filter((wait) => wait.phase === 'open' && !isSquawkHumanWait(wait));
  if (!open.length) return undefined;
  const items = open.map(describeWait);
  const asked = open.some((wait) => waitPolicyForWait(wait).userAnswers);
  const cancellable = open.some((wait) => !waitPolicyForWait(wait).userAnswers);
  const kinds = Object.values(WAIT_KINDS).flatMap(row => row.footerKinds).sort((a, b) => a.order - b.order).map(kind => kind.text);
  const kindList = `${kinds.slice(0, -2).join(', ')} or ${kinds.at(-2)} wait or ${kinds.at(-1)}`;
  const close = !asked ? 'Call cezar_cancel_wait for any you no longer need.'
    : cancellable ? `The user's reply answers your question; call cezar_cancel_wait for any ${kindList} you no longer need.`
    : "The user's reply answers it.";
  return `Still open: ${items.join('; ')}. ${close}`;
}

/** Fixed opening turn; the queued results themselves are delivered after its turn end. */
export function sessionlessWakePrompt(resolved: ReturnType<typeof resolvedWaits>): string {
  const prompts = resolved.map(wait => waitPolicyForWait(wait).sessionlessPrompt);
  return prompts.sort((a, b) => a.priority - b.priority)[0]?.text
    ?? `Resume to receive queued messages. End this opening turn so Squawk can deliver them.`;
}

/** The first budgeted wait label, with monitoring timers ahead of ordinary timers, processes and peers. */
export function waitDeliveryLabel(waits: readonly Wait[]): string | undefined {
  return waits.flatMap(wait => waitPolicyForWait(wait).deliveryLabel(wait)).sort((a, b) => a.priority - b.priority)[0]?.text;
}

/** The handler of each registration path. A new path fails typecheck until every router names it. */
export type RegistrationRoutes<R> = { readonly [P in keyof RegistrationRequest]: (request: RegistrationRequest[P]) => R };

/** Request dispatch follows the typed registration cell of its stored-kind row. A row that
 *  registers its own handler is served by it before this route. */
export function routeRegistration<R>(request: SquawkWaitRequest, routes: RegistrationRoutes<R>): R {
  const path = waitRequestRow(request.kind).registration;
  if (path === 'none' || path === 'handler') throw new Error('Unsupported wait registration');
  return (routes[path as keyof RegistrationRequest] as (request: SquawkWaitRequest) => R)(request);
}

/** Typed built-in view. Every read still checks the registry's boot seal. */
export const WAIT_KINDS = new Proxy({} as { readonly [K in Wait['kind']]: BuiltInWaitKindRow<K> }, {
  get(_target, key: string) {
    if (key === 'plugin') { registeredWaitKinds(); return BUILT_IN_WAIT_ROWS.plugin; }
    return waitKindRow(key);
  },
  ownKeys: () => [...registeredWaitKinds().map(row => row.kind), 'plugin'],
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
});

export type WaitKindRow<K extends Wait['kind']> = BuiltInWaitKindRow<K>;

/** Unknown persisted plugin kinds keep their generic display and cancellation policy. */
export function waitPolicyForWait(wait: Wait) {
  return waitKindForWait(wait) ?? BUILT_IN_WAIT_ROWS.plugin;
}

/** A timer resolves at its deadline. */
const timerWatch: WaitLifecycle = { arm: context => context.armDeadline() };

/** Watches a process wait's command (hearsay-tools/cezarion#1446). Like a timer, its wake is the
 *  agent's own arrangement: a stopping, stopped or finishing run takes none, and the wait stays
 *  open for that transition to cancel. */
const watchingProcesses = new WeakSet<WaitWatchContext>();
const processWatch: WaitLifecycle = {
  arm(context) {
    if (watchingProcesses.has(context)) return;
    watchingProcesses.add(context);
    const wait = context.wait as ProcessWaitEntry;
    const settle = (result: ProcessWaitResult) => {
      if (context.disposed() || context.signal.aborted) return;
      watchingProcesses.delete(context);
      if (!context.host.canProceedWithRun(context.runId, context.store.getRun(context.runId))) return;
      context.resolve(result);
    };
    const request = { pid: wait.pid, deadline: wait.deadline, roots: context.exitFileRoots(),
      ...(wait.startToken === undefined ? {} : { startToken: wait.startToken }), ...(wait.exitFile === undefined ? {} : { exitFile: wait.exitFile }) };
    void context.processes.watch(request, context.signal).then(settle, (error: unknown) => settle({ outcome: 'error', observedAt: new Date().toISOString(),
      diagnostic: (error instanceof Error ? error.message : String(error)).slice(0, 512) }));
  },
};

/** Native subagents live only in their session: with none, as at a restart, they stopped
 *  (hearsay-tools/cezarion#2431). At its deadline a lost session reads the same. */
const subagentWatch: WaitLifecycle = {
  arm(context) {
    if (context.deadlineArmed()) return;
    const interrupted = () => !context.host.subagentSessionLive(context.runId);
    if (interrupted()) { context.host.interruptSubagentWait(context.runId, context.wait.id); return; }
    context.armDeadline(() => {
      if (interrupted()) context.host.interruptSubagentWait(context.runId, context.wait.id);
      else context.resolve();
    });
  },
};

// Only the user's answer, or a cancel, ends a human wait: nothing to arm.
const coreLifecycles: { readonly [K in Exclude<CoreWaitKind, 'plugin'>]?: WaitLifecycle } = { timer: timerWatch, process: processWatch, subagent: subagentWatch };
const coreRows = ['human', 'timer', 'process'] as const;
const registrations = new Map<string, ReturnType<typeof builtInWaitRegistration>>();
function builtInWaitRegistration(kind: Exclude<CoreWaitKind, 'plugin'>) {
  const lifecycle = coreLifecycles[kind];
  return { ...BUILT_IN_WAIT_ROWS[kind], kind, inputs: builtInWaitInputs(kind), ...(lifecycle ? { lifecycle } : {}) };
}
/** Stable references let repeated boot calls register the same built-ins idempotently. */
function registerBuiltInWaitKind(kind: Exclude<CoreWaitKind, 'plugin'>): void {
  let row = registrations.get(kind);
  if (!row) { row = builtInWaitRegistration(kind); registrations.set(kind, row); }
  registerWaitKind(row);
}
export function registerCoreWaitKinds(): void {
  for (const kind of coreRows) registerBuiltInWaitKind(kind);
}
/** The runner's native subagent wait, through the same registry. */
export function registerSubagentWaitKind(): void {
  registerBuiltInWaitKind('subagent');
}
