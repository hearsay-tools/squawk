import { waitKindRow, parsePluginWaitRequest, type WaitRegistryPort, type WaitRequestContext, type WaitRequestHost } from './wait-kind-registry.ts';
import { pluginWaitEntrySchema, type Wait } from '@open-mercato/cezar-contract/waits';
import { warnRegistrationRefused, type WaitEngine } from './wait-engine.ts';
import { WAIT_KINDS, routeRegistration, waitPolicyForWait, waitRequestRow } from './wait-kinds.ts';
import { openRegistered, registrationIdentity, replayRegistration, repeatRegistration, type RegistrationIdentity } from './wait-registration.ts';
import { workerWaitRequestSchema, type WorkerWait } from '@open-mercato/cezar-contract/delegation';
import { requestWaitRequestSchema, type RequestWaitRequest } from '@open-mercato/cezar-contract/conversations';
import { workerWaitEntryToLegacy } from '@open-mercato/cezar-contract/waits';
import { supervisedByFamilyRecord } from '../../runs/task-rights.ts';
import { randomUUID } from 'node:crypto';
import type { RunModuleContext } from './types.ts';
import type { ActiveRun } from '../active-run.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { WorkerWaitRequest } from '@open-mercato/cezar-contract/delegation';
import { type AskErrorCode, type WaitErrorCode, type WaitVia, type HumanWaitEntry, type PrWaitEntry, type TimerWaitEntry, type WorkerWaitEntry, type DeadlinedWorkerWaitEntry, type ProcessWaitEntry, type PeerWaitEntry } from '@open-mercato/cezar-contract/waits';
import { squawkAskRequestSchema, builtInSquawkWaitRequestSchema, type BuiltInSquawkWaitRequest, type SquawkAskRequest, type SquawkWaitRequest, type SquawkWaitRequestInput } from '@open-mercato/cezar-contract/wait-tools';

import { askErrorMessage, waitErrorMessage } from '../../ci-wait/errors.ts';
import { toolSessionRefusal } from './squawk-tools.ts';
import { answeringAskSeq, pendingQuestion, yieldAnsweredSlot } from './human-waits.ts';
import { askCardFields } from './turn-markers.ts';
import { identicalWait, timerWaitEntry, processWaitEntry } from '../waits.ts';
import { isSessionLeader } from '../../core/session-process.ts';
import { probeProcessWait } from '../../process-wait/supervisor.ts';
import { confineExitFile } from '../../process-wait/exit-file.ts';
import { processStartToken, recordedProcessLive } from '../../core/process-stat.ts';

/** CI identity stays live across registration and rotates at the existing turn boundaries. */
export class WaitGroup {
  #ciTurnId: string | undefined;
  constructor() { Object.freeze(this); }
  get ciTurnId(): string | undefined { return this.#ciTurnId; }
  ensureCiTurn(): string { return this.#ciTurnId ??= randomUUID(); }
  rotateCiTurn(turnId: string): void { this.#ciTurnId = turnId; }
}

Object.freeze(WaitGroup.prototype);
type RegisteredWait = Extract<Wait, { kind: 'plugin' }> | PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry;
const OPEN_REGISTERED = openRegistered;
Object.freeze(WaitGroup);
export function createWaitGroup(): WaitGroup { return new WaitGroup(); }

/** Feature wait kinds add their own services through `WaitFeatureServices`. */
interface WaitRegistryHost extends WaitRequestHost {
  waitEngine: WaitEngine;
  active(id: string): ActiveRun | undefined;
  workerExecutionStopped(id: string): boolean;
  countAutomaticWakes(id: string): number;
  reconcileWorkerWaits(family?: string): void;
}

export class WaitRegistry {
  /** Registrations in flight, by wait key: keyed by wait, not by run (ADR 0061). */
  readonly pendingRegistrations = new Map<string, { runId: string; abort: AbortController; promise: Promise<Wait> }>();
  /** What a feature's registration reaches of this registry. */
  private readonly port: WaitRegistryPort;
  constructor(private readonly context: RunModuleContext, private readonly host: WaitRegistryHost, private readonly maxAutoContinues: number) {
    this.port = {
      get store() { return context.store; },
      get engine() { return host.waitEngine; },
      disposed: () => context.disposed(),
      active: id => host.active(id),
      reconcileWorkerWaits: family => host.reconcileWorkerWaits(family),
    };
  }
  abortRegistrations(runId: string): void {
    for (const [key, registration] of this.pendingRegistrations) {
      if (registration.runId !== runId) continue;
      registration.abort.abort(); this.pendingRegistrations.delete(key);
    }
  }

  dispose(): void {
    for (const task of this.pendingRegistrations.values()) task.abort.abort();
    this.pendingRegistrations.clear();
  }
  /** `cez worker wait`: an alias into the wait list, answered in the legacy `WorkerWait` shape
   *  (hearsay-tools/cezarion#1235). */
  registerWorkerWait(parentId: string, request: WorkerWaitRequest): WorkerWait {
    const parsed = workerWaitRequestSchema.parse(request);
    return workerWaitEntryToLegacy(this.registerWorkerListWait(parentId, parsed, 'cez-worker-wait'));
  }

  /** A `worker` wait in the list (hearsay-tools/cezarion#1235), registered by its row. */
  registerWorkerListWait(runId: string, request: { workerIds?: string[]; requestIds?: string[] | undefined; mode?: WorkerWaitRequest['mode']; timeoutSeconds: number },
    via: 'cezar_wait' | 'cez-worker-wait', registration?: RegistrationIdentity): DeadlinedWorkerWaitEntry {
    return WAIT_KINDS.worker.registerList(this.port, runId, request, via, registration);
  }

  /** Squawk's wait on the workers or requests the completion gate named, registered by its row. */
  registerCompletionWait(runId: string, workerIds: string[], requestIds?: string[]): WorkerWaitEntry | undefined {
    return WAIT_KINDS.worker.registerCompletion(this.port, runId, workerIds, requestIds);
  }

  /** Both roles can select their own requests without acquiring worker-management authority.
   *  `cez message wait --request`: an alias into the wait list (hearsay-tools/cezarion#1235). */
  registerRequestWait(runId: string, request: RequestWaitRequest): WorkerWait {
    const parsed = requestWaitRequestSchema.parse(request);
    return workerWaitEntryToLegacy(this.registerWorkerListWait(runId, parsed, 'cez-worker-wait'));
  }

  /** `cezar_wait` kind `peer` and `cez message wait --peer` (hearsay-tools/cezarion#1995), registered by its row. */
  registerPeerWait(runId: string, request: { peerIds: string[]; timeoutSeconds: number }, via: 'cezar_wait' | 'cez-message-wait', registration?: RegistrationIdentity): PeerWaitEntry {
    return WAIT_KINDS.peer.registerPeer(this.port, runId, request, via, registration);
  }

  /** `cez message cancel-wait` on a peer wait, through its row; a settled one comes back as it is. */
  cancelPeerWait(runId: string, waitId: string): PeerWaitEntry {
    return WAIT_KINDS.peer.cancelPeer(this.port, runId, waitId);
  }

  /** The checks every wait registration shares: the session that called is the run's current one,
   *  and no root finish blocks it. Refusals throw `{ code }`. */
  private registrationGate(runId: string, generation: string, capabilitySignal?: AbortSignal) {
    const state = this.host.active(runId);
    const refuse = (code: WaitErrorCode | AskErrorCode): never => {
      // Fixed codes only: no tool arguments, credentials or provider diagnostics.
      warnRegistrationRefused(code);
      throw Object.assign(new Error(code === 'autonomous_run' || code === 'supervisor_is_worker' ? askErrorMessage(code) : waitErrorMessage(code)), { code });
    };
    const assertCanRegister = () => {
      const refused = toolSessionRefusal(this.context.store.getRun(runId), state, this.host.active(runId), generation, capabilitySignal, this.context.disposed());
      const run = this.context.store.getRun(runId);
      if (refused || !run || !state) return refuse(refused ?? 'run_missing');
      if (this.host.workerExecutionStopped(runId)) refuse('worker_execution_stopped');
      if (this.host.executionBlockedByRootFinish(run)) refuse('root_finish_pending');
      return { state, run };
    };
    return { refuse, assertCanRegister };
  }

  /**
   * `cezar_ask` (hearsay-tools/cezarion#1234): open the run's human wait with its card. A run holds
   * one: a registration in the turn that opened it replaces its card and keeps its id, and one after
   * the user saw it returns it unchanged. An autonomous run assumes and continues instead, until
   * its automatic wakes are spent.
   */
  async registerAsk(runId: string, request: SquawkAskRequest, generation: string, capabilitySignal?: AbortSignal): Promise<HumanWaitEntry> {
    const card = askCardFields(squawkAskRequestSchema.parse(request));
    const { refuse, assertCanRegister } = this.registrationGate(runId, generation, capabilitySignal);
    const { state: active, run } = assertCanRegister();
    // A question card goes to the task that holds the family record; a worker another worker started asks that worker by message.
    if (run.delegation?.role === 'worker' && !supervisedByFamilyRecord(run)) refuse('supervisor_is_worker');
    const turnId = active.waitIdentity.ensureCiTurn();
    if (active.boundary.autonomous && this.host.countAutomaticWakes(runId) < this.maxAutoContinues) refuse('autonomous_run');
    // The question this turn's opening answers stays open only until the turn end settles it, so
    // a question asked in that turn is a new one, never the answered one returned
    // (hearsay-tools/cezarion#2397).
    const answering = answeringAskSeq(active);
    const open = pendingQuestion(run, answering);
    if (open?.askSeq !== undefined) return open;
    if (!open && !this.host.waitEngine.hasRoom(yieldAnsweredSlot(this.context.store, runId, answering, candidate => this.host.waitEngine.hasRoom(candidate)) ?? run)) refuse('capacity');
    const base: HumanWaitEntry = open ?? WAIT_KINDS.human.entry(turnId);
    const { context: _replaced, ...kept } = base;
    return this.host.waitEngine.open(runId, active, { ...kept, ...card }, OPEN_REGISTERED(undefined)).wait!;
  }

  /**
   * Open a built-in or plugin wait from `cezar_wait` (hearsay-tools/cezarion#1233). Trusted
   * capability callbacks supply run identity; the model supplies only the request. Refusals throw
   * `{ code }`. A row that registers its own handler serves its request after the shared gate;
   * timers and processes keep their core routes. An identical timer registration (the same
   * seconds and note in the same turn) returns the open wait it repeats.
   */
  async registerWait(runId: string, request: SquawkWaitRequestInput, via: WaitVia, generation: string, capabilitySignal?: AbortSignal): Promise<RegisteredWait> {
    const plugin = waitKindRow(request.kind);
    if (plugin?.isPlugin) return this.registerPluginWait(runId, request, via, generation, capabilitySignal);
    const parsed = builtInSquawkWaitRequestSchema.parse(request);
    const registration = registrationIdentity(parsed);
    const replay = replayRegistration(this.context.store.getRun(runId), registration);
    if (replay) return replay as PrWaitEntry | TimerWaitEntry | WorkerWaitEntry | ProcessWaitEntry | PeerWaitEntry;
    const { refuse, assertCanRegister } = this.registrationGate(runId, generation, capabilitySignal);
    const { state: active, run } = assertCanRegister();
    const handler = waitRequestRow(parsed.kind).registerRequest;
    if (handler) {
      const request = parsed as BuiltInSquawkWaitRequest;
      return await handler(request, this.requestContext({ runId, run, state: active, via, generation, registration, refuse, assertCanRegister }, request, capabilitySignal)) as RegisteredWait;
    }
    return routeRegistration<RegisteredWait | Promise<RegisteredWait>>(parsed, {
      process: request => this.registerProcessWait(runId, active, run, request, via, active.waitIdentity.ensureCiTurn(), registration),
      timer: request => {
        const turnId = active.waitIdentity.ensureCiTurn();
        const repeated = this.repeatOrRefuseFull(runId, run, request, turnId, registration, refuse);
        if (repeated) return repeated;
        this.checkAutomaticWaitAdmission('timer', runId, refuse);
        const wait = timerWaitEntry(request, via, turnId, Date.now());
        return this.host.waitEngine.open(runId, active, wait, OPEN_REGISTERED(registration)).wait!;
      },
    });
  }

  /** What a row's request handler reads and calls, bound to this request. */
  private requestContext(base: Pick<WaitRequestContext, 'runId' | 'run' | 'state' | 'via' | 'generation' | 'registration' | 'refuse' | 'assertCanRegister'>,
    request: BuiltInSquawkWaitRequest, capabilitySignal: AbortSignal | undefined): WaitRequestContext {
    const { runId, run, state, registration, refuse } = base;
    return { ...base, store: this.context.store, host: this.host, port: this.port,
      turnId: () => state.waitIdentity.ensureCiTurn(),
      hasRoom: current => this.host.waitEngine.hasRoom(current),
      repeat: (wait, timeoutSeconds) => repeatRegistration(this.context.store, runId, wait, timeoutSeconds, registration),
      repeatOrRefuseFull: turnId => this.repeatOrRefuseFull(runId, run, request, turnId, registration, refuse),
      open: wait => this.host.waitEngine.open(runId, state, wait, OPEN_REGISTERED(registration)).wait!,
      inFlight: (key, timeoutSeconds, start) => this.inFlight(runId, key, timeoutSeconds, registration, capabilitySignal, start),
    };
  }

  /** One registration per key at a time. A second caller awaits the first and repeats its wait;
   *  the run's abort, the registry's dispose or the capability signal ends a lookup in flight. */
  private async inFlight(runId: string, key: string, timeoutSeconds: number, registration: RegistrationIdentity | undefined,
    capabilitySignal: AbortSignal | undefined, start: (signal: AbortSignal) => Promise<Wait>): Promise<Wait> {
    const pending = this.pendingRegistrations.get(key);
    if (pending) {
      const wait = await pending.promise;
      return repeatRegistration(this.context.store, runId, wait, timeoutSeconds, registration);
    }
    const abort = new AbortController();
    const signal = capabilitySignal ? AbortSignal.any([abort.signal, capabilitySignal]) : abort.signal;
    const promise = start(signal);
    this.pendingRegistrations.set(key, { runId, abort, promise });
    try { return await promise; }
    finally { if (this.pendingRegistrations.get(key)?.abort === abort) this.pendingRegistrations.delete(key); }
  }

  private async registerPluginWait(runId: string, request: SquawkWaitRequestInput, via: WaitVia, generation: string, capabilitySignal?: AbortSignal) {
    const row = waitKindRow(request.kind)!;
    if (!row.inputSchema || !row.register) throw Object.assign(new Error('Plugin wait has no registration handler'), { code: 'invalid_request' });
    const parsed = parsePluginWaitRequest(row, request);
    row.canonicalizePlugin?.(parsed);
    const { refuse, assertCanRegister } = this.registrationGate(runId, generation, capabilitySignal);
    const { state, run } = assertCanRegister();
    const turnId = state.waitIdentity.ensureCiTurn();
    const registration = registrationIdentity(parsed);
    const replay = replayRegistration(run, registration);
    if (replay) return replay as Extract<RegisteredWait, { kind: 'plugin' }>;
    const duplicate = (current: RunRecord) => current.waits?.find(wait => wait.kind === 'plugin' && wait.pluginKind === row.kind && wait.phase === 'open' && row.duplicatePlugin?.(wait, parsed, turnId));
    const repeated = duplicate(run);
    if (repeated) return repeatRegistration(this.context.store, runId, repeated, undefined, registration) as Extract<RegisteredWait, { kind: 'plugin' }>;
    if (!this.host.waitEngine.hasRoom(run)) refuse('capacity');
    if (row.timersDisabled && this.context.semaphore.monitoringWakeIntervalMinutes() === null) refuse('timers_disabled');
    if (row.refusesSpentBudget && this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) refuse('wake_budget_spent');
    const wait = pluginWaitEntrySchema.parse(await row.register(parsed, { runId, turnId, via, now: Date.now(), signal: capabilitySignal }));
    const { run: latest } = assertCanRegister();
    if (state.waitIdentity.ciTurnId !== turnId) refuse('turn_changed');
    // Another operation may have committed the same wait while this handler yielded.
    const concurrent = duplicate(latest);
    if (concurrent) return repeatRegistration(this.context.store, runId, concurrent, undefined, registration) as Extract<RegisteredWait, { kind: 'plugin' }>;
    if (wait.pluginKind !== row.kind || wait.phase !== 'open') refuse('invalid_request');
    return this.host.waitEngine.open(runId, state, wait, OPEN_REGISTERED(registration)).wait!;
  }

  /** A registration that repeats an open wait returns it; otherwise a full list refuses it.
   *  Counted as the store counts them, so a registration accepted here is never refused there. */
  private repeatOrRefuseFull(runId: string, run: RunRecord, request: BuiltInSquawkWaitRequest, turnId: string,
    registration: RegistrationIdentity | undefined, refuse: (code: WaitErrorCode) => never): PrWaitEntry | TimerWaitEntry | ProcessWaitEntry | undefined {
    const existing = identicalWait(run.waits ?? [], request, turnId);
    if (existing) return repeatRegistration(this.context.store, runId, existing, waitRequestRow(request.kind).requestedTimeout(request), registration) as typeof existing;
    if (!this.host.waitEngine.hasRoom(run)) refuse('capacity');
    return undefined;
  }

  /** The two automatic kinds share refusal rules, but keep each caller's error policy. */
  private checkAutomaticWaitAdmission(kind: 'timer' | 'process', runId: string, refuse: (code: WaitErrorCode) => never): void {
    const row = WAIT_KINDS[kind];
    if (row.timersDisabled && this.context.semaphore.monitoringWakeIntervalMinutes() === null) refuse('timers_disabled');
    if (row.refusesSpentBudget && this.host.countAutomaticWakes(runId) >= this.maxAutoContinues) refuse('wake_budget_spent');
  }

  /**
   * A process wait (hearsay-tools/cezarion#1446, spec § Process wait decisions). Squawk refuses only
   * what it cannot watch to an end: another user's PID, its own, and an agent session's leader;
   * the agent's shell can already observe any process of its own, so there is no ownership proof.
   * A PID already gone is no error: the command was fast, and the wait resolves at once from its
   * exit file, or as exited.
   */
  private registerProcessWait(runId: string, active: ActiveRun, run: RunRecord, request: Extract<SquawkWaitRequest, { kind: 'process' }>, via: WaitVia, turnId: string, registration?: RegistrationIdentity): ProcessWaitEntry {
    const refuse = (code: WaitErrorCode): never => { throw Object.assign(new Error(waitErrorMessage(code)), { code }); };
    this.checkAutomaticWaitAdmission('process', runId, refuse);
    const roots = this.host.waitEngine.exitFileRoots(runId, run);
    let exitFile: string | undefined;
    if (request.exit_file !== undefined) {
      const confined = confineExitFile(request.exit_file, roots, request.pid);
      if (!confined.ok) return refuse('exit_file_outside');
      exitFile = confined.path;
    }
    if (request.pid === process.pid || isSessionLeader(request.pid)) refuse('process_not_allowed');
    try { process.kill(request.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') refuse('process_not_owned'); }
    const live = recordedProcessLive({ pid: request.pid });
    const startToken = live ? processStartToken(request.pid) : undefined;
    const existing = identicalWait(run.waits ?? [], request, turnId, { ...(startToken === undefined ? {} : { startToken }), ...(exitFile === undefined ? {} : { exitFile }) });
    if (existing && WAIT_KINDS.process.is(existing)) return repeatRegistration(this.context.store, runId, existing, request.timeout_seconds, registration) as ProcessWaitEntry;
    if (!this.host.waitEngine.hasRoom(run)) refuse('capacity');
    const now = Date.now();
    const wait = processWaitEntry(request, via, turnId, now, startToken, exitFile);
    // A PID already gone resolves at once from its exit file, or as exited: no watch arms.
    const settled = live ? {} : { result: probeProcessWait({ pid: wait.pid, deadline: wait.deadline, roots, ...(exitFile === undefined ? {} : { exitFile }) }, now) };
    return this.host.waitEngine.open(runId, active, wait, { ...OPEN_REGISTERED(registration), ...settled }).wait!;
  }

  /**
   * The agent's `cezar_cancel_wait`. An open wait is cancelled with its watch or timer, and no
   * result for it is ever delivered. A resolved wait is already owed: cancelling it is a no-op and
   * its result arrives with the next wake. A settled or unknown id is `not_found`. A human wait the
   * user already sees is theirs to answer (`human_question`); one from this turn can be withdrawn.
   */
  cancelWait(runId: string, waitId: string, generation: string): { cancelled: true } | { cancelled: false; code: 'not_found' | 'already_resolved' | 'human_question' } {
    const state = this.host.active(runId);
    if (this.context.disposed() || !state || state.liveSession.ciGeneration !== generation) {
      throw Object.assign(new Error(waitErrorMessage('generation_mismatch')), { code: 'generation_mismatch' });
    }
    const wait = this.context.store.getRun(runId)?.waits?.find(entry => entry.id === waitId);
    if (!wait) return { cancelled: false, code: 'not_found' };
    if (wait.phase !== 'open') return { cancelled: false, code: 'already_resolved' };
    if (waitPolicyForWait(wait).cancellable === 'unshown' && 'askSeq' in wait && wait.askSeq !== undefined) return { cancelled: false, code: 'human_question' };
    this.host.waitEngine.cancel(runId, [waitId]);
    return { cancelled: true };
  }

}
