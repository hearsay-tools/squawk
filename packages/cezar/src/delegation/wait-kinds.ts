import { randomUUID } from 'node:crypto';
import type { BuiltInSquawkWaitRequest as SquawkWaitRequest, DeadlinedWorkerWaitEntry, PeerWaitEntry, PeerWaitResult, Wait, WorkerWaitEntry } from '@open-mercato/cezar-contract';
import { commandText } from '../home/command.ts';
import { isUserAnsweredKind, waitInputId } from '../runs/wait-helpers.ts';
import { familyOf, executionBlockedByRootFinish, historyDeletionPending, rootFinishRequested } from '../workflows/run/run-guards.ts';
import { registerWaitKind, type WaitKindRegistration, type WaitLifecycle, type WaitRegistryPort, type WaitRequestContext, type WaitWatchContext } from '../workflows/run/wait-kind-registry.ts';
import { builtInWaitInputs } from '../workflows/run/wait-input-descriptors.ts';
import { ENDS_WAITS, WAIT_KINDS, clipWaitSummary, identicalPeerWait, identicalWorkerWait, waitSelectors, type BuiltInWaitKindRow, type WorkerListRequest, type WorkerTarget } from '../workflows/run/wait-kinds.ts';
import { openRegistered, repeatRegistration, type RegistrationIdentity } from '../workflows/run/wait-registration.ts';
import { assertOwnedWorkerWaitScope, assertRequestWaitScope, delegationWaitRefusal, peerWaitEntry, peerWaitOf, peerWaitResult, waitCapacityPolicyError, workerListTarget, workerWaitTarget } from '../workflows/wait-scope.ts';
import { DelegationPolicyError, requireMessagingAllowed } from './policy.ts';

/** The `worker` and `peer` wait kinds of delegation: their rows, their registrations and their
 *  watches. The core engine reaches them only through the wait-kind registry. */

type WorkerRequest = Extract<SquawkWaitRequest, { kind: 'worker' | 'request' }>;
type PeerRequest = Extract<SquawkWaitRequest, { kind: 'peer' }>;

function peerWaitBuilder(request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-message-wait', turnId: () => string): PeerWaitEntry {
  const now = Date.now();
  return { id: randomUUID(), kind: 'peer', source: 'agent', via, registeredAt: new Date(now).toISOString(),
    deadline: new Date(now + request.timeoutSeconds * 1000).toISOString(), timeoutSeconds: request.timeoutSeconds,
    turnId: turnId(), phase: 'open', peerIds: request.peerIds };
}

function workerWaitBuilder(request: { timeoutSeconds: number; mode?: 'one' | 'all' | 'any' | undefined }, via: 'cezar_wait' | 'cez-worker-wait', now: number, turnId: string, target: WorkerTarget): WorkerWaitEntry & { deadline: string } {
  const entry: WorkerWaitEntry & { deadline: string } = { id: randomUUID(), kind: 'worker', source: 'agent', via, registeredAt: new Date(now).toISOString(),
      deadline: new Date(now + request.timeoutSeconds * 1000).toISOString(), timeoutSeconds: request.timeoutSeconds,
      turnId, phase: 'open', ...(request.mode === undefined ? {} : { mode: request.mode }), ...target };
  return entry;
}

function completionWaitEntry(turnId: string, target: WorkerTarget): WorkerWaitEntry {
  const entry: WorkerWaitEntry = { id: randomUUID(), kind: 'worker', source: 'cezar', via: 'completion', registeredAt: new Date().toISOString(),
      turnId, phase: 'open', mode: 'all', ...target };
  return entry;
}

/**
 * A worker wait's result, worded as `cez worker wait`'s wake always was
 * (hearsay-tools/cezarion#1235). 32 summaries, including worst-case JSON escaping, must fit the
 * ordinary input bound, so each is abbreviated; the full ones stay in the outcomes and events.
 */
function workerWaitResultText(wait: WorkerWaitEntry, workerStatus: (workerId: string) => string): string {
  const reason = wait.result?.reason ?? 'timeout';
  if (wait.requestIds) {
    return `Request wait ${wait.id} (${reason}). Request outcomes: ${JSON.stringify(wait.requestOutcomes ?? [])}. This is not worker completion or review approval.`;
  }
  const outcomes = (wait.outcomes ?? []).map(outcome => ({ ...outcome, ...(outcome.summary ? { summary: outcome.summary.slice(0, 256) } : {}) }));
  return `Worker wait ${wait.id} (${reason === 'timeout' ? 'deadline reached' : 'terminal outcome'}). ` +
    `Collect each worker's latest settled result before completing the parent. Review is not merge permission. Selected workers: ${JSON.stringify((wait.workerIds ?? []).map(workerId => ({
      workerId, status: workerStatus(workerId),
    })))}. Outcomes (summaries abbreviated): ${JSON.stringify(outcomes)}`;
}

/** A peer wait's result (hearsay-tools/cezarion#1995). The message itself arrives as its own
 *  input in the same wake; this names only why the wait ended. */
function peerWaitResultText(wait: PeerWaitEntry): string {
  const result = wait.result;
  const head = `Peer wait ${wait.id} on ${peerTargetPhrase(wait)}`;
  if (result?.reason === 'message') return `${head}: task ${result.peerRunId ?? 'unknown'} sent message ${result.messageId ?? 'unknown'}, delivered with this wake. Register another peer wait if you still wait on it.`;
  if (result?.reason === 'settled') return `${head}: task ${result.peerRunId ?? 'unknown'} settled or was deleted; it will not write again until its human continues it. ${commandText('Read its status with cez message tasks.')}`;
  return `${head}: deadline reached with no message. Register another peer wait if you still wait on it.`;
}

function peerTargetPhrase(wait: PeerWaitEntry): string {
  const n = wait.peerIds.length;
  return n === 1 ? `task ${wait.peerIds[0]}` : `${n} tasks`;
}

function workerTargetPhrase(wait: WorkerWaitEntry): string {
  const n = (wait.requestIds ?? wait.workerIds)?.length ?? 0;
  return wait.requestIds ? `${n} ${n === 1 ? 'reply' : 'replies'}` : `${n} ${n === 1 ? 'worker' : 'workers'}`;
}

const hasWorkerDeadline = (wait: Wait): wait is DeadlinedWorkerWaitEntry => wait.kind === 'worker' && wait.deadline !== undefined;

/** The states no worker or peer wait registers in: refusals throw `incompatible_state`. Waits stand
 *  beside CI, timer and human waits and beside each other (hearsay-tools/cezarion#1235). */
function assertCanRegisterWorkerWait(port: WaitRegistryPort, runId: string): void {
  const run = port.store.getRun(runId);
  const state = port.active(runId);
  const refuse = (message: string): never => { throw new DelegationPolicyError('incompatible_state', message); };
  if (!run?.delegation || run.delegation.role === 'invalid') refuse('Worker waits require an owned worker or parent run');
  if (historyDeletionPending(port.store, runId)) refuse('History deletion is pending; finish deletion before registering a wait');
  if (executionBlockedByRootFinish(port.store, run!)) refuse('Parent finish is pending; a finishing parent cannot register a wait');
  if (!['running', 'waiting'].includes(run!.status) || !state?.liveSession.session?.open || state.liveSession.cancelled) {
    refuse(`Run is ${run!.status} with no available active session; register a wait from an executing parent or worker`);
  }
}

/**
 * Open a `worker` wait in the list (hearsay-tools/cezarion#1235): on workers the parent owns, or
 * on replies to requests the run sent. It stands beside CI, timer and human waits, up to
 * `WAIT_LIMIT` open ones; the same target and mode return the open wait instead. The family is
 * reconciled at once, so outcomes already in resolve it now, and its deadline is armed.
 * Refusals throw `DelegationPolicyError`: `incompatible_state`, `denied_scope` or
 * `capacity_limit`.
 */
function registerWorkerListWait(port: WaitRegistryPort, runId: string, request: WorkerListRequest,
  via: 'cezar_wait' | 'cez-worker-wait', registration?: RegistrationIdentity): DeadlinedWorkerWaitEntry {
  port.reconcileWorkerWaits();
  assertCanRegisterWorkerWait(port, runId);
  const run = port.store.getRun(runId)!;
  const state = port.active(runId)!;
  if (!run.delegation || run.delegation.role === 'invalid') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
  const getRun = (id: string) => port.store.getRun(id);
  if (request.workerIds) assertOwnedWorkerWaitScope(run, request.workerIds, getRun);
  else assertRequestWaitScope(run, request.requestIds ?? [], getRun, port.store.conversations);
  const repeated = identicalWorkerWait(run.waits ?? [], request);
  if (repeated && hasWorkerDeadline(repeated)) return repeatRegistration(port.store, runId, repeated, request.timeoutSeconds, registration) as DeadlinedWorkerWaitEntry;
  if (!port.engine.hasRoom(run)) throw waitCapacityPolicyError();
  const now = Date.now();
  const target = workerWaitTarget(request, getRun);
  const entry = workerWaitBuilder(request, via, now, state.waitIdentity.ensureCiTurn(), target);
  return port.engine.open(runId, state, entry, { withdraw: true, receipt: registration, onCommitFailure: { capacity: waitCapacityPolicyError }, park: true }).wait!;
}

/** Squawk waits on live workers or open requests without adding a deadline of its own. The
 *  workers are the ones the completion gate named as blocking this run's done (`liveWorkerIds`):
 *  this applies no ownership rule of its own, so the gate and the wait cannot disagree. A blocker
 *  whose record is gone has nothing to observe; with no target left, no wait opens. */
function registerCompletionWait(port: WaitRegistryPort, runId: string, workerIds: string[], requestIds?: string[]): WorkerWaitEntry | undefined {
  if (!port.engine.hasRoom(port.store.getRun(runId) ?? {})) return;
  const state = port.active(runId)!;
  const ids = workerIds.filter(id => port.store.getRun(id)?.delegation?.role === 'worker');
  if (!requestIds?.length && !ids.length) return;
  const entry = completionWaitEntry(state.waitIdentity.ensureCiTurn(),
    workerWaitTarget(requestIds?.length ? { requestIds } : { workerIds: ids }, id => port.store.getRun(id)));
  return port.engine.open(runId, state, entry, { withdraw: false, park: false }).wait!;
}

/** `cezar_wait` kind `peer` and `cez message wait --peer` (hearsay-tools/cezarion#1995): checked
 *  and built by `peerWaitEntry`; a peer that already wrote or settled resolves it at once (its arm). */
function registerPeerWait(port: WaitRegistryPort, runId: string, request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-message-wait', registration?: RegistrationIdentity): PeerWaitEntry {
  assertCanRegisterWorkerWait(port, runId);
  const state = port.active(runId)!;
  const entry = peerWaitEntry(port.store.getRun(runId)!, request, via, () => state.waitIdentity.ensureCiTurn(), id => port.store.getRun(id));
  if (port.store.getRun(runId)?.waits?.some(wait => wait.id === entry.id)) {
    return repeatRegistration(port.store, runId, entry, request.timeoutSeconds, registration) as PeerWaitEntry;
  }
  // A new peer wait is peer messaging (hearsay-tools/cezarion#2784); an open one keeps running.
  requireMessagingAllowed(port.store.getRun(runId)!);
  return port.engine.open(runId, state, entry, openRegistered(registration)).wait!;
}

/** `cez message cancel-wait` on a peer wait, through the list, as `cancelWorkerWait`; a settled one comes back as it is. */
function cancelPeerWait(port: WaitRegistryPort, runId: string, waitId: string): PeerWaitEntry {
  const run = port.store.getRun(runId)!;
  if (peerWaitOf(run, waitId).phase !== 'open') return peerWaitOf(run, waitId);
  if (port.disposed() || !['queued', 'running', 'waiting'].includes(run.status) || rootFinishRequested(port.store, runId) || historyDeletionPending(port.store, runId)) {
    throw new DelegationPolicyError('incompatible_state', 'Parent cannot cancel a peer wait');
  }
  port.engine.cancel(runId, [waitId]);
  return peerWaitOf(port.store.getRun(runId), waitId);
}

/** `cezar_wait` kinds `worker`, `request` and `peer` keep the CLI checks under the tool's codes. */
function registerDelegation<W extends Wait>(context: WaitRequestContext, register: () => W): W {
  if (!context.run.delegation || context.run.delegation.role === 'invalid') context.refuse('denied_scope');
  try { return register(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'duplicate_deadline') throw error;
    return context.refuse(delegationWaitRefusal(error, () => context.host.executionBlockedByRootFinish(context.run)));
  }
}

/**
 * A worker wait's deadline re-observes its family (hearsay-tools/cezarion#1235): the reconcile
 * resolves it with `timeout`, keeping any outcome observed by then. A failed checkpoint is
 * retried every second while the wait is still open, never dropped as an uncaught error. An
 * outcome whose resolution failed to commit arms the same retry with `firstDelay` 1 second.
 */
function armWorkerDeadline(context: WaitWatchContext, firstDelay?: number): void {
  const wait = context.wait as WorkerWaitEntry;
  // A deadline-less (Squawk completion) wait ends only when its workers settle (hearsay-tools/cezarion#1301).
  if (firstDelay === undefined && wait.deadline === undefined) return;
  const run = context.store.getRun(context.runId);
  if (!run) return;
  const family = familyOf(run);
  let warned = false;
  const arm = (delay: number) => context.armTimer(delay, () => {
    try { context.host.reconcileWorkerWaits(family); }
    catch {
      if (!warned) console.warn(`[hsq] worker wait checkpoint failed; retrying in 1 second`);
      warned = true;
      if (!context.disposed() && context.store.getRun(context.runId)?.waits?.some(entry => entry.id === wait.id && entry.phase === 'open')) arm(1_000);
    }
  });
  arm(Math.max(0, firstDelay ?? Date.parse(wait.deadline!) - Date.now()));
}

const workerWatch: WaitLifecycle = {
  // Outcomes already in resolve it now (or, with every worker destroyed, cancel it); the rest arm it.
  // A worker that parked before this wait opened tells the parent now (hearsay-tools/cezarion#1327).
  // Squawk's completion wait tells its own workers; an agent's wait tells its family.
  open(context) {
    const run = context.store.getRun(context.runId)!;
    context.host.reconcileWorkerWaits(familyOf(run));
    context.host.noticeParkedWorkers(context.wait.source === 'cezar' ? context.runId : familyOf(run));
  },
  arm(context) { if (!context.deadlineArmed()) armWorkerDeadline(context); },
  rearm: armWorkerDeadline,
  // A worker wait the family reconcile already resolved is no longer listed, and parks nothing.
  parkOnlyWhileListed: true,
  // A worker wait with a deadline may already be settled by the reconcile.
  openedEntry: (wait, waits) => waits.find(entry => entry.id === wait.id && hasWorkerDeadline(entry)) ?? wait,
};

/** Like a timer, the wake is the agent's own arrangement: a stopping or finishing run takes none,
 *  and the wait stays for that transition to cancel. True when the wait is no longer open. */
function resolvePeerNow(context: WaitWatchContext): boolean {
  const run = context.store.getRun(context.runId);
  if (context.disposed() || !context.host.canProceedWithRun(context.runId, run)) return false;
  const result = peerWaitResult(run, context.wait as PeerWaitEntry, context.store);
  if (result) context.resolve(result);
  return !!result && context.store.getRun(context.runId)?.waits?.find(entry => entry.id === context.wait.id)?.phase !== 'open';
}

const peerWatch: WaitLifecycle = {
  // A peer that already wrote or settled resolves it first, at registration and recovery alike.
  arm(context) { if (!context.deadlineArmed() && !resolvePeerNow(context)) context.armDeadline(); },
  reconcile: resolvePeerNow,
};

export const WORKER_WAIT_ROW: BuiltInWaitKindRow<'worker'> = {
  ...waitSelectors('worker'),
  capNote: (wait, maxAutoContinues) => `automatic ${WAIT_KINDS.timer.monitoring(wait) ? 'monitoring' : 'timer'} wake-up cap reached (${maxAutoContinues}); timer ${wait.id} cancelled`,
  deliveryLabel: () => [],
  sessionlessPrompt: { priority: 1, text: `Resume to receive the queued worker wait result. End this opening turn so Squawk can deliver it.` },
  summary: wait => { const worker = wait as WorkerWaitEntry; return clipWaitSummary(`${worker.requestIds ? 'request' : 'worker'} wait on ${workerTargetPhrase(worker)}`); },
  resultText: (wait, workerStatus) => workerWaitResultText(wait as WorkerWaitEntry, workerStatus),
  // Squawk's completion wait has no deadline (hearsay-tools/cezarion#1301).
  footerItem: wait => { const worker = wait as WorkerWaitEntry; return `${worker.requestIds ? 'request' : 'worker'} wait ${worker.id} on ${workerTargetPhrase(worker)}, ${worker.deadline === undefined ? 'no deadline' : `deadline ${worker.deadline}`}`; },
  footerKinds: [{ order: 1, text: 'worker' }, { order: 2, text: 'request' }],
  resolve: (latest, _result, observed, resolvedAt) => ({ ...observed ?? latest as WorkerWaitEntry, phase: 'resolved', resolvedAt, result: observed?.result ?? { reason: 'timeout' } }),
  inputId: waitInputId,
  entry: workerWaitBuilder,
  completionEntry: completionWaitEntry,
  duplicate: () => false,
  canonicalize: request => { if ((request.kind === 'worker' || request.kind === 'request') && request.mode === undefined) request.mode = 'any'; },
  repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
  requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
  duplicateWorker: identicalWorkerWait,
  answerKind: wait => 'requestIds' in wait && wait.requestIds ? 'request' : 'worker',
  hasDeadline: wait => 'deadline' in wait && wait.deadline !== undefined,
  registration: 'handler', requestKinds: ['worker', 'request'],
  delegation: true,
  workerListTarget: request => ({ ...(request.kind === 'worker' ? { workerIds: request.worker_ids } : { requestIds: request.request_ids }), ...(request.mode === undefined ? {} : { mode: request.mode }), timeoutSeconds: request.timeout_seconds }),
  registerList: registerWorkerListWait,
  registerCompletion: registerCompletionWait,
  userAnswers: isUserAnsweredKind('worker'), holdsConversationInput: false, runnerResumeCancels: [],
  chargesWake: false, refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
  failedResult: wait => { const worker = wait as WorkerWaitEntry; return worker.result?.reason === 'timeout' || (worker.outcomes ?? []).some(outcome => outcome.status === 'failed' || outcome.status === 'cancelled') ||
    (worker.requestOutcomes ?? []).some(outcome => outcome.status !== 'replied' && outcome.status !== 'replied-late'); },
  deadline: 'agent-only', keepsSlot: false, cancels: [...ENDS_WAITS, 'the parent settles'], resolves: [
    { trigger: 'the workers report outcomes or the requests get replies, as its mode says', firedBy: 'worker' },
    { trigger: `the deadline of an agent wait; Squawk's completion wait has none`, firedBy: 'timer' },
  ],
};

export const PEER_WAIT_ROW: BuiltInWaitKindRow<'peer'> = {
  ...waitSelectors('peer'),
  capNote: (wait, maxAutoContinues) => `automatic ${wait.kind} wake-up cap reached (${maxAutoContinues}); ${wait.kind} wait ${wait.id} cancelled`,
  deliveryLabel: () => [{ priority: 3, text: 'peer' }],
  sessionlessPrompt: { priority: 3, text: `Resume to receive the queued timer result. End this opening turn so Squawk can deliver it.` },
  summary: wait => clipWaitSummary(`peer wait on ${peerTargetPhrase(wait as PeerWaitEntry)}`),
  resultText: wait => peerWaitResultText(wait as PeerWaitEntry),
  footerItem: wait => { const peer = wait as PeerWaitEntry; return `peer wait ${peer.id} on ${peerTargetPhrase(peer)}, deadline ${peer.deadline}`; },
  footerKinds: [{ order: 3, text: 'peer' }],
  resolve: (latest, result, _observed, resolvedAt) => ({ ...latest as PeerWaitEntry, phase: 'resolved', resolvedAt, result: (result as PeerWaitResult | undefined) ?? { reason: 'timeout' } }),
  inputId: waitInputId,
  entry: peerWaitBuilder,
  duplicate: () => false,
  canonicalize: () => {},
  repeatTimeout: wait => 'timeoutSeconds' in wait ? wait.timeoutSeconds : undefined,
  requestedTimeout: request => 'timeout_seconds' in request ? request.timeout_seconds : undefined,
  duplicatePeer: identicalPeerWait,
  registerPeer: registerPeerWait,
  cancelPeer: cancelPeerWait,
  answerKind: () => 'peer',
  hasDeadline: () => true,
  registration: 'handler', requestKinds: ['peer'],
  delegation: true,
  userAnswers: isUserAnsweredKind('peer'), holdsConversationInput: false, runnerResumeCancels: [],
  chargesWake: wait => (wait as PeerWaitEntry).result?.reason !== 'timeout', refusesSpentBudget: false, holdsSession: false, cancellable: true, timersDisabled: false,
  failedResult: wait => (wait as PeerWaitEntry).result?.reason === 'timeout',
  deadline: 'required', keepsSlot: false, cancels: [...ENDS_WAITS, 'the wake budget is spent at its resolution'], resolves: [
    { trigger: 'a message of any kind from a named peer', firedBy: 'peer' },
    { trigger: 'a named peer settles or is deleted', firedBy: 'watcher' },
    { trigger: 'the deadline (1 to 7,200 s, default 600)', firedBy: 'timer' },
  ],
};

let workerRegistration: WaitKindRegistration | undefined;
let peerRegistration: WaitKindRegistration | undefined;
/** Register the `worker` wait kind (it also serves `request` waits). A stable reference keeps
 *  repeated boot calls idempotent. */
export function registerWorkerWaitKind(): void {
  workerRegistration ??= { ...WORKER_WAIT_ROW, kind: 'worker', inputs: builtInWaitInputs('worker'), lifecycle: workerWatch,
    // hearsay-tools/cezarion#1235: as `cez worker wait`, under the tool's own codes. It answers its
    // own repeat, so it is checked before the shared capacity check.
    registerRequest: (request, context) => registerDelegation(context,
      () => registerWorkerListWait(context.port, context.runId, workerListTarget(request as WorkerRequest), 'cezar_wait', context.registration)) };
  registerWaitKind(workerRegistration);
}
/** Register the `peer` wait kind. */
export function registerPeerWaitKind(): void {
  peerRegistration ??= { ...PEER_WAIT_ROW, kind: 'peer', inputs: builtInWaitInputs('peer'), lifecycle: peerWatch,
    // hearsay-tools/cezarion#1995: as `cez message wait`, under the tool's own codes.
    registerRequest: (request, context) => {
      const peer = request as PeerRequest;
      return registerDelegation(context, () => registerPeerWait(context.port, context.runId, { peerIds: peer.peer_ids, timeoutSeconds: peer.timeout_seconds }, 'cezar_wait', context.registration));
    } };
  registerWaitKind(peerRegistration);
}
