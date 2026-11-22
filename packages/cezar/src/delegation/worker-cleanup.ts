import { randomUUID } from 'node:crypto';
import type { WorkerDestroy, WorkerDestroyResult } from '@open-mercato/cezar-contract/delegation';
import type { RunRecord } from '../runs/store.ts';
import { hostsLiveSharedWorker, SHARED_HOST_REFUSAL } from '../runs/shared-hosts.ts';
import { supervisedWorkers } from '../runs/supervised.ts';
import { supervisorIdOf } from '../runs/task-rights.ts';
import { collectWorkerEvidence } from './results.ts';
import { controllerRefusal } from '../runs/worker-execution.ts';
import { DelegationPolicyError } from './policy.ts';
import { describeProcesses, isCurrentProcess, recordedProcessLive } from '../core/process-stat.ts';
import { workspaceDirectoryRemoved, workspaceKind, type WorkspaceResource } from './workspace-kinds.ts';
import { loadConfig } from '../config.ts';
import { DESTROY_ATTENTION_ATTEMPTS, DESTROY_BACKOFF, retryDelayMs, type Backoff } from './retry-backoff.ts';
import { WORKTREE_LOCK_BUSY_PREFIX } from './workspace-removal.ts';
import { describeWork } from './workspace-work.ts';
import { workerExecutionsOf } from './worker-executions.ts';

/** How long an explicit destroy waits in the worktree mutation lock queue: long enough for a
 * settling worker's own Git work to finish (hearsay-tools/squawk#3817). */
export const MANUAL_DESTROY_LOCK_WAIT_MS = 30_000;
/** The part of the CLI's 45 s request bound an explicit destroy may use before its lock wait ends,
 * so the caller reads the answer, holder and retry time included, instead of a transport timeout. */
export const MANUAL_DESTROY_ANSWER_BY_MS = 40_000;
import type { DelegationProject, DestroyOptions, WorkerCleanupFactory } from './service.ts';

/** Why the worker's scope is not this controller's to stop: its current generation's record names
 * another live Squawk, or cannot be read. Undefined when it is ours. */
function foreignControl(store: DelegationProject['store'], workerId: string): string | undefined {
  const generation = store.workerExecutions.readWorkerExecution(workerId)?.generation;
  const record = generation ? store.workerExecutions.readWorkerProcesses(workerId, generation) : 'absent';
  if (record === 'unknown') return 'worker process record is unreadable';
  if (record === 'absent' || isCurrentProcess(record.controller) || !recordedProcessLive(record.controller)) return undefined;
  return controllerRefusal(record.controller.pid).message;
}

/** A worker that failed before any step started: no agent ran in it, so it holds no work, and its
 * resources and cap slot are released without the parent asking (hearsay-tools/squawk#3817). */
export function failedBeforeFirstStep(store: DelegationProject['store'], run: RunRecord): boolean {
  return run.delegation?.role === 'worker' && run.status === 'failed' && !run.delegation.destroy &&
    !run.steps.some(step => step.startedAt) && store.workerExecutions.readWorkerExecution(run.id)?.phase === 'complete';
}

/** Whether a destroy attempt may delete work: an explicit attempt of it allowed that now or
 * earlier, and the pending destroy keeps the approval (hearsay-tools/squawk#3553). */
function discardsWork(worker: RunRecord, options: DestroyOptions | undefined): boolean {
  return options?.discardWork === true || (worker.delegation?.role === 'worker' && worker.delegation.destroy?.discardWork === true);
}

/** Tests pass shorter cadences and termination waits through these constructor options. */
export type WorkerCleanupOptions = {
  now?: () => number;
  backoff?: Backoff;
  attentionAttempts?: number;
  terminationTimeoutMs?: number;
  manualLockWaitMs?: number;
};

type Serialize = <T>(key: string, operation: () => Promise<T>) => Promise<T>;

/** What a process entry hands to `DelegationService`: one `WorkerCleanup` per registered project. */
export function workerCleanups(options: WorkerCleanupOptions = {}): WorkerCleanupFactory {
  return (project, isAttached, serialized) => new WorkerCleanup(project, isAttached, serialized, options);
}

/** One registered project's destroy state and retry lifecycle. */
export class WorkerCleanup {
  private detached = false;
  private readonly projects: Pick<Map<string, DelegationProject>, 'get'>;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;

  constructor(private readonly project: DelegationProject, isAttached: () => boolean,
    private readonly serialized: Serialize, options: WorkerCleanupOptions = {}) {
    this.projects = { get: id => !this.detached && id === project.id && isAttached() ? project : undefined };
    this.now = options.now ?? Date.now;
    this.destroyBackoff = options.backoff ?? DESTROY_BACKOFF;
    this.destroyAttentionAttempts = options.attentionAttempts ?? DESTROY_ATTENTION_ATTEMPTS;
    this.terminationTimeoutMs = options.terminationTimeoutMs ?? 30_000;
    this.manualLockWaitMs = options.manualLockWaitMs ?? MANUAL_DESTROY_LOCK_WAIT_MS;
    // The record as it stands now, not the write's snapshot: an earlier listener's nested write of
    // the run reaches this one first. A conflict's payload is the other writer's record.
    this.unsubscribe = project.store.lifecycle.subscribe({
      'run.created': ({ run }) => this.onRun(project.store.getRun(run.id) ?? run),
      'run.updated': ({ run, source }) => this.onRun(source === 'conflict' ? run : project.store.getRun(run.id) ?? run),
    });
  }

  /** Every run change, a status change or not (a worker's execution completes in a write that
   *  changes no status): a worker that just failed before its first step is destroyed in the background. */
  private readonly onRun = (run: RunRecord): void => {
    if (failedBeforeFirstStep(this.project.store, run)) this.releaseFailedStart(run.id);
  };
  private failStartReleases = new Set<string>();
  /** One automatic destroy per fail-start worker; an incomplete one continues on the retry cadence. */
  private releaseFailedStart(workerId: string): void {
    const project = this.projects.get(this.project.id);
    if (!project || this.failStartReleases.has(workerId)) return;
    this.failStartReleases.add(workerId);
    const check = () => {
      if (this.projects.get(project.id) !== project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
      const current = project.store.getRun(workerId);
      if (current?.delegation?.role !== 'worker' || current.delegation.workspace.ownerRunId !== workerId || current.status !== 'failed' ||
        current.delegation.destroy?.phase === 'complete') throw new DelegationPolicyError('incompatible_state', 'Worker is no longer a failed start');
      // Until destroy intent is written, the worker must still be a failed start: a parent's resume
      // can queue, run and fail it again while this release waits its turn. `destroyAttempt` calls
      // this last with no await before it writes the intent; after that, a resume is refused.
      if (!current.delegation.destroy && !failedBeforeFirstStep(project.store, current)) {
        throw new DelegationPolicyError('incompatible_state', 'Worker is no longer a failed start');
      }
      return current;
    };
    // Off the store's emit: the attempt writes runs itself.
    setImmediate(() => {
      void this.serialized(`worker:${project.id}:${workerId}`, async () => {
        if (!failedBeforeFirstStep(project.store, check())) return;
        await this.serialized(`destroy-retries:${project.id}`, () => this.destroyAttempt(project, workerId, check, 'scheduled', this.now()));
      }).catch(() => undefined).finally(() => {
        this.failStartReleases.delete(workerId);
        this.scheduleDestroyRetry(project, workerId);
      });
    });
  }

  request(workerId: string, check: () => RunRecord, options: DestroyOptions = {}): Promise<WorkerDestroyResult> {
    const refusal = this.project.store.retention.fallbackDeleteError(workerId, 'worktree');
    if (refusal) return Promise.reject(new DelegationPolicyError('incompatible_state', refusal));
    return this.destroySerialized(this.project, workerId, check, options);
  }

  armAfterRecovery(): void {
    this.armDestroyRetries(this.project.id);
    // A fail-start that settled while no controller ran is released now. `listRuns` holds only live
    // runs, and a settled failed worker is not one: read every worker.
    for (const id of this.project.store.queries.listWorkerIds()) {
      const run = this.project.store.getRun(id);
      if (run && failedBeforeFirstStep(this.project.store, run)) this.releaseFailedStart(id);
    }
  }

  detach(): void {
    this.clearDestroyRetries(this.project.id);
    this.unsubscribe();
    this.detached = true;
  }

  private destroyRetryTimers = new Map<string, Map<string, NodeJS.Timeout>>();
  private destroyRetryInFlight = new Map<string, Set<string>>();
  private readonly destroyBackoff: Backoff;
  private readonly destroyAttentionAttempts: number;
  private readonly terminationTimeoutMs: number;
  private readonly manualLockWaitMs: number;
  /** When each armed automatic attempt is due, so an explicit destroy's answer can say when. */
  private destroyRetryDue = new Map<string, Map<string, number>>();
  private clearDestroyRetries(projectId: string): void {
    for (const timer of this.destroyRetryTimers.get(projectId)?.values() ?? []) clearTimeout(timer);
    this.destroyRetryTimers.delete(projectId);
    this.destroyRetryInFlight.delete(projectId);
    this.destroyRetryDue.delete(projectId);
  }
  /** Called only after manager recovery, when persisted destroy intents may be retried. */
  private armDestroyRetries(projectId: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    project.manager.recoverWorkerCleanup();
    // A pending destroy keeps its worker in the live set (`isLiveRecord`), so this is every one.
    for (const run of project.store.queries.listRuns()) this.scheduleDestroyRetry(project, run.id);
  }
  /** Arms the next automatic attempt of a pending destroy. A retry state written before a restart
   * resumes where it was; the fast cadence is the floor, and a little over the cap the ceiling, so
   * a clock that jumped cannot park a destroy for days (hearsay-tools/cezarion#879). */
  private scheduleDestroyRetry(project: DelegationProject, workerId: string): void {
    if (this.projects.get(project.id) !== project || project.store.claims.isFallbackRun(workerId)) return;
    const run = project.store.getRun(workerId);
    if (run?.delegation?.role !== 'worker' || !run.delegation.destroy || run.delegation.destroy.phase === 'complete') return;
    let timers = this.destroyRetryTimers.get(project.id);
    if (!timers) { timers = new Map(); this.destroyRetryTimers.set(project.id, timers); }
    if (timers.has(workerId) || this.destroyRetryInFlight.get(project.id)?.has(workerId)) return;
    const { fastMs, capMs } = this.destroyBackoff;
    const nextAt = run.destroyRetry ? Date.parse(run.destroyRetry.nextAt) - this.now() : 0;
    const delay = Math.min(Math.max(fastMs, nextAt), capMs * 1.1);
    let due = this.destroyRetryDue.get(project.id);
    if (!due) { due = new Map(); this.destroyRetryDue.set(project.id, due); }
    due.set(workerId, this.now() + delay);
    const timer = setTimeout(() => {
      timers.delete(workerId);
      due.delete(workerId);
      if (this.projects.get(project.id) !== project) return;
      let inFlight = this.destroyRetryInFlight.get(project.id);
      if (!inFlight) { inFlight = new Set(); this.destroyRetryInFlight.set(project.id, inFlight); }
      inFlight.add(workerId);
      void this.destroyTick(project, workerId).catch(() => undefined).finally(() => {
        inFlight.delete(workerId);
        this.scheduleDestroyRetry(project, workerId);
      });
    }, delay);
    timer.unref?.();
    timers.set(workerId, timer);
  }
  /** One automatic attempt. It records the attempt and when the next is due, and from the attention
   * threshold on the cockpit says the cleanup needs attention. */
  private destroyTick(project: DelegationProject, workerId: string) {
    return this.serialized(`worker:${project.id}:${workerId}`, async () => {
      const check = () => {
        if (this.projects.get(project.id) !== project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
        const current = project.store.getRun(workerId);
        if (current?.delegation?.role !== 'worker' || current.delegation.workspace.ownerRunId !== workerId || !current.delegation.destroy || current.delegation.destroy.phase === 'complete') {
          throw new DelegationPolicyError('incompatible_state', 'Worker destroy is no longer pending');
        }
        return current;
      };
      check();
      // One automatic attempt at a time per project: attempts that coincide (every pending destroy
      // after a restart) would otherwise contend for the worktree mutation lock.
      await this.serialized(`destroy-retries:${project.id}`, () => this.destroyAttempt(project, workerId, check, 'scheduled', this.now())).catch(() => undefined);
      if (this.projects.get(project.id) !== project) return;
      const current = project.store.getRun(workerId);
      if (current?.delegation?.role !== 'worker' || !current.delegation.destroy || current.delegation.destroy.phase === 'complete') return;
      const attempts = (current.destroyRetry?.attempts ?? 0) + 1;
      const retry = { attempts, nextAt: new Date(this.now() + retryDelayMs(attempts, this.destroyBackoff)).toISOString(),
        ...(attempts >= this.destroyAttentionAttempts ? { needsAttention: true as const } : {}) };
      project.store.commitDestroyRetry(workerId, retry);
    });
  }
  /** An explicit destroy's lock wait: what is left of its answer budget after termination, at least 1 s. */
  private manualLockWait(startedAt: number): number {
    return Math.max(1_000, Math.min(this.manualLockWaitMs, MANUAL_DESTROY_ANSWER_BY_MS - (this.now() - startedAt)));
  }
  /** The project's raw `worktreeTeardown` value, read fresh at each attempt. */
  private async teardownConfig(project: DelegationProject): Promise<unknown> {
    return (await loadConfig(project.root, project.home)).worktreeTeardown;
  }
  /** An explicit destroy (Clean up, `cez worker destroy`): always a full attempt, and it restarts the
   * backoff, so a timer armed for a later automatic attempt is dropped and re-armed at the fast cadence. */
  private async destroySerialized(project: DelegationProject, workerId: string, check: () => RunRecord, options: DestroyOptions) {
    const rearm = () => {
      // A replaced registration owns its own timers under the same project id: leave them alone.
      if (this.projects.get(project.id) !== project) return;
      const timers = this.destroyRetryTimers.get(project.id);
      clearTimeout(timers?.get(workerId)); timers?.delete(workerId);
      this.destroyRetryDue.get(project.id)?.delete(workerId);
      this.scheduleDestroyRetry(project, workerId);
    };
    let result: WorkerDestroyResult;
    // The answer budget starts when the request arrives, so time queued behind another attempt counts.
    const requestedAt = this.now();
    try {
      result = await this.serialized(`worker:${project.id}:${workerId}`, async () =>
        await this.workRefusal(project, workerId, check, options) ?? this.destroyAttempt(project, workerId, check, 'manual', requestedAt, options));
    }
    finally { rearm(); }
    // A busy lock clears by itself: say when the next automatic attempt runs (hearsay-tools/squawk#3817).
    const due = this.destroyRetryDue.get(project.id)?.get(workerId);
    return result.error?.startsWith(WORKTREE_LOCK_BUSY_PREFIX) && due !== undefined
      ? { ...result, error: `${result.error}; Squawk retries automatically at ${new Date(due).toISOString()}` } : result;
  }
  /** hearsay-tools/squawk#3553: an explicit destroy that would delete work refuses, naming it,
   * before it changes anything, so the parent can still resume or collect the worker. A failed
   * read leaves the decision to the checked removal, which reads the work again under the lock. */
  private async workRefusal(project: DelegationProject, workerId: string, check: () => RunRecord, options: DestroyOptions): Promise<WorkerDestroyResult | undefined> {
    const worker = check();
    if (worker.delegation?.role !== 'worker' || discardsWork(worker, options)) return undefined;
    const kind = workspaceKind(worker.delegation.workspace);
    const work = await kind.work(project.root, worker.delegation.workspace).catch(() => undefined);
    if (!work) return undefined;
    return { workerId, state: 'incomplete', remaining: worker.delegation.destroy?.remaining ?? ['process', ...kind.destroyResources], work, error: describeWork(workerId, work) };
  }
  /**
   * A worker's destroy first stops and destroys the workers it started, which work in its
   * directory, and then asks whether a live worker still works there. Returns why the worker's own
   * destroy cannot go on yet, or undefined.
   *
   * Lock order: an explicit destroy holds the supervisor's key and takes each child's key in turn.
   * A scheduled attempt already holds the project's `destroy-retries` key, and a child's own
   * scheduled attempt takes its key before that one, so a scheduled attempt never waits for a
   * child's key: it records the child's destroy, leaves it to the child's own retry and reports
   * itself incomplete until that retry has finished.
   */
  private async destroySupervised(project: DelegationProject, workerId: string, mode: 'manual' | 'scheduled', startedAt: number): Promise<string | undefined> {
    const worker = project.store.getRun(workerId);
    for (const child of supervisedWorkers(project.store, worker)) {
      const record = child.delegation?.role === 'worker' ? child.delegation : undefined;
      if (!record || (record.destroy?.phase === 'complete' && !record.destroy.remaining.length)) continue;
      const held = (error?: string) => `Worker ${child.id}, which this worker started, is not destroyed yet${error ? `: ${error}` : ''}`.slice(0, 2_000);
      if (mode === 'scheduled') {
        if (!record.destroy) {
          project.store.commitDelegation([{ id: child.id, delegation: { ...record, destroy: { requestedAt: new Date().toISOString(), phase: 'requested',
            remaining: ['process', ...workspaceKind(record.workspace).destroyResources] } } }]);
        }
        this.scheduleDestroyRetry(project, child.id);
        return held('its cleanup retries on its own');
      }
      const check = () => {
        const current = project.store.getRun(child.id);
        if (current?.delegation?.role !== 'worker' || supervisorIdOf(current) !== workerId) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
        return current;
      };
      const result = await this.serialized(`worker:${project.id}:${child.id}`, () => this.destroyAttempt(project, child.id, check, mode, startedAt));
      if (result.state !== 'complete') return held(result.error);
    }
    const current = project.store.getRun(workerId);
    return current && hostsLiveSharedWorker(current, rootId => project.store.queries.listWorkersOf(rootId)) ? SHARED_HOST_REFUSAL : undefined;
  }

  /** One full destroy attempt; the caller holds the worker's serialization key. A manual attempt
   * clears the run's `destroyRetry`, which resets the backoff; a completed destroy drops it. */
  private async destroyAttempt(project: DelegationProject, workerId: string, check: () => RunRecord, mode: 'manual' | 'scheduled',
    startedAt: number, options?: DestroyOptions): Promise<WorkerDestroyResult> {
    const assertAttached = () => {
      if (this.projects.get(project.id) !== project) throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    };
    assertAttached();
    let worker = check();
    if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const parent = project.store.getRun(worker.delegation.parentRunId);
    if (parent?.delegation?.role === 'root' && parent.delegation.receipts.some(receipt => receipt.workerId === workerId && receipt.deletion)) {
      throw new DelegationPolicyError('incompatible_state', 'Worker history deletion has begun; retry history deletion');
    }
    const teardown = await this.teardownConfig(project);
    assertAttached();
    worker = check();
    if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
    const workspace = worker.delegation.workspace;
    const kind = workspaceKind(workspace);
    const requestedAt = worker.delegation.destroy?.requestedAt ?? new Date().toISOString();
    const resources = (worker.delegation.destroy?.remaining ?? kind.destroyResources).filter((resource): resource is WorkspaceResource => resource !== 'process');
    const discardWork = discardsWork(worker, options);
    const persist = (phase: WorkerDestroy['phase'], remaining: WorkerDestroy['remaining'], error?: string) => {
      assertAttached();
      worker = project.store.getRun(workerId)!;
      if (worker.delegation?.role !== 'worker') throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
      project.store.commitDelegation([{ id: workerId, delegation: { ...worker.delegation, destroy: { requestedAt, phase, remaining,
        ...(error ? { error: error.slice(0, 2_000) } : {}), ...(discardWork ? { discardWork: true as const } : {}) } } }]);
      // The retry state lives beside the delegation: an explicit destroy and a completed one both drop it.
      if (worker.destroyRetry && (phase === 'complete' || (mode === 'manual' && phase === 'requested'))) project.store.commitDestroyRetry(workerId, undefined);
    };
    const terminationFailure = (): WorkerDestroyResult => {
      // #469: name what blocks a crashed generation; other causes keep the generic message.
      const taken = project.manager.takeWorkerTerminationBlocker(workerId);
      const reason = taken && (taken.blocker.kind === 'unreadable' ? 'worker process record is unreadable; termination cannot be proven'
        : taken.blocker.kind === 'controller' ? controllerRefusal(taken.blocker.pid).message
        : `the previous execution's ${taken.blocker.pids.length === 1 ? 'process' : 'processes'} ${describeProcesses(taken.blocker.pids)} still ${taken.blocker.pids.length === 1 ? 'runs' : 'run'}`);
      if (taken?.changed) project.store.eventLog.appendEvent(workerId, { type: 'lifecycle', message: `destroy blocked: ${reason}` });
      const result: WorkerDestroyResult = { workerId, state: 'incomplete', remaining: ['process', ...resources], error: !taken ? 'Worker termination is not proven; retry cleanup later'
        : taken.blocker.kind === 'unreadable' ? reason! : `Worker termination is not proven: ${reason}; retry cleanup later` };
      persist(result.state, result.remaining, result.error);
      return result;
    };
    const scopeFailure = (error: string): WorkerDestroyResult => {
      const result: WorkerDestroyResult = { workerId, state: 'incomplete', remaining: ['process', ...resources], error: `Worker processes were not stopped: ${error}; retry cleanup later` };
      persist(result.state, result.remaining, result.error);
      return result;
    };
    const cleanWorkspace = async (): Promise<WorkerDestroyResult> => {
      persist('cleaning', resources);
      let result: WorkerDestroyResult;
      const snapshot = structuredClone(check());
      const proof = project.store.workerExecutions.readWorkerExecution(workerId);
      const evidence = await collectWorkerEvidence(project.root, project.store, snapshot);
      assertAttached();
      const current = check();
      if (proof?.phase !== 'complete' || project.store.workerExecutions.readWorkerExecution(workerId)?.generation !== proof.generation ||
        project.store.workerExecutions.readWorkerExecution(workerId)?.phase !== 'complete' || current.status !== snapshot.status ||
        JSON.stringify(current.delegation) !== JSON.stringify(snapshot.delegation)) throw new Error('Worker changed before cleanup checkpoint');
      // This immutable parent payload must be durable before the first destructive operation. A
      // payload already on disk is durable, whatever cleanup phase it names (hearsay-tools/cezarion#879).
      project.store.workerResults.commitWorkerResult(evidence.result.parentRunId, evidence.result, evidence.diffSnapshot, { ignoreCleanup: true });
      assertAttached();
      check();
      const release = project.manager.claimWorkerCleanup(workerId);
      const assertCurrent = () => {
        assertAttached();
        const current = check();
        if (!release || current.delegation?.role !== 'worker' ||
          JSON.stringify(current.delegation.workspace) !== JSON.stringify(workspace) ||
          project.store.workerExecutions.readWorkerExecution(workerId)?.generation !== proof.generation ||
          project.store.workerExecutions.readWorkerExecution(workerId)?.phase !== 'complete') {
          throw new Error('Worker resource ownership changed');
        }
      };
      // The worker's recorded processes ended with its scope; one still live is a new execution.
      const assertSafe = () => {
        assertCurrent();
        if (project.store.workerExecutions.workerResourceHolders(workerId, proof.generation, workspace.resourceId) !== 'safe') throw new Error('Worker processes still run; cleanup will retry');
      };
      try {
        assertCurrent();
        // #781: release preview before the final check immediately preceding removal.
        result = await kind.remove(project.root, workspace, { previewHost: project.manager.previewHost, assertCurrent, assertUnheld: assertSafe,
          ...(mode === 'manual' ? { waitMs: this.manualLockWait(startedAt) } : {}), ...(discardWork ? { discardWork } : {}) });
      } catch (error) {
        result = { workerId, state: 'incomplete', remaining: resources,
          error: `Worker resources could not be verified: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}; cleanup will retry` };
      } finally { release?.(); }
      // An already-started checked Git operation may finish after detach. Its
      // checkpoint makes a new controller's retry safe; the old store must not
      // publish a result after ownership of the project has moved.
      assertAttached();
      persist(result.state, result.remaining, result.error);
      // Preserve the captured bytes even if Git removal was only partially successful.
      const removed = workspaceDirectoryRemoved(workspace, result.remaining);
      project.store.workerResults.commitWorkerResult(evidence.result.parentRunId, { ...evidence.result, observedAt: new Date().toISOString(),
        cleanup: result.state, outcome: result.state === 'complete' ? 'destroyed' : evidence.result.lastExecutionOutcome,
        workspace: { ...workspace, state: removed ? 'deleted' : evidence.result.workspace.state },
        head: removed ? { state: 'deleted', reason: 'missing', ...('sha' in evidence.result.head ? { sha: evidence.result.head.sha } : {}) } : evidence.result.head,
        diff: evidence.result.diff.state === 'available' ? { ...evidence.result.diff, snapshotId: randomUUID() } : evidence.result.diff,
      }, evidence.diffSnapshot);
      project.manager.reconcileWorkerWaits(evidence.result.parentRunId);
      return result;
    };
    const recordFailure = (error: unknown) => {
      // hearsay-tools/cezarion#879: an attempt that throws says why, instead of leaving an
      // in-progress phase with no error, as long as this is still the same pending destroy.
      try {
        const current = this.projects.get(project.id) === project ? project.store.getRun(workerId) : undefined;
        if (current?.delegation?.role === 'worker' && current.delegation.destroy?.requestedAt === requestedAt && current.delegation.destroy.phase !== 'complete') {
          persist('incomplete', current.delegation.destroy.remaining, error instanceof Error ? error.message : String(error));
        }
      } catch { /* the attempt's own error is the one to report */ }
    };
    // The recorded destroy keeps this worker from starting another one; the ones it started go first.
    const heldBySupervised = async (): Promise<WorkerDestroyResult | undefined> => {
      persist('requested', worker.delegation?.role === 'worker' && worker.delegation.destroy?.remaining || ['process', ...kind.destroyResources]);
      const held = await this.destroySupervised(project, workerId, mode, startedAt);
      assertAttached();
      if (!held) return undefined;
      persist('incomplete', ['process', ...resources], held);
      return { workerId, state: 'incomplete', remaining: ['process', ...resources], error: held };
    };
    const held = await heldBySupervised();
    if (held) return held;
    try {
      persist('terminating', ['process', ...resources]);
      project.manager.requestWorkerStop(workerId);
      // Registered services stop gracefully while the worktree they run in still exists.
      const teardownError = await kind.teardown(project.root, teardown, workspace);
      // A project replaced during the teardown keeps its old manager alive: never reap through it.
      assertAttached();
      if (teardownError) project.store.eventLog.appendEvent(workerId, { type: 'lifecycle', message: `worktree teardown failed: ${teardownError}` });
      const terminated = await project.manager.awaitRunTermination(workerId, this.terminationTimeoutMs, { reapOrphans: true });
      assertAttached();
      if (!terminated) return terminationFailure();
      // A worker another live Squawk still controls is not ours to stop, settled or not.
      const foreign = foreignControl(project.store, workerId);
      if (foreign) return scopeFailure(foreign);
      // Everything else the worker started, detached descendants included where the host contains
      // them, ends with its scope (ADR 0032).
      const stopped = await workerExecutionsOf(project.store).scopes.stop(workerId, this.terminationTimeoutMs);
      assertAttached();
      if (!stopped.stopped) return scopeFailure(stopped.error);
      return await cleanWorkspace();
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  }
}
