import { logPrefix } from '../../home/display.ts';
import type { AgentSession } from '../../core/claude-cli-runner.ts';
import { sessionGroupOf } from '../../core/session-process.ts';
import type { RunModuleContext } from './types.ts';
import type { WorkerOrphans } from './worker-orphans.ts';
import type { RunMemory } from './run-memory.ts';
import { WorkerAdmissionRefusal } from '../../runs/worker-execution.ts';

interface WorkerExecutionsHost {
  maintenance(id: string): boolean;
  settleOrphanedWorkerExecution(id: string, opts?: { admitting?: boolean; fresh?: boolean }): boolean;
  reapTerminalScratch(id: string): void;
  queueWaitWake(id: string): void;
  retryWaitAdmission(id: string): void;
  releaseSlot(): void;
  /** The execution left: the run's memory goes if the run has ended (`runMemoryReleases`). */
  releaseRunMemory(id: string): void;
}

export class WorkerExecutions {
  constructor(private readonly context: RunModuleContext, private readonly orphans: WorkerOrphans, private readonly host: WorkerExecutionsHost,
    private readonly memory: RunMemory) {}
  /** Kept here: an entry lives for one worker generation, from `beginWorkerExecution` to
   *  `finishWorkerExecution`. `dispose` keeps it: a disposed manager's execution still settles its
   *  own sessions, turns and deliveries, and `proveRunTermination` waits on it. */
  readonly executions = new Map<string, { generation: string; admitted: boolean; promise: Promise<void>; resolve: () => void; sessions: Set<Promise<void>>; turns: Set<Promise<void>>; deliveries: Set<Promise<void>> }>();
  /** Kept here: a generation whose completion write failed, kept for one explicit retry
   *  (`proveRunTermination`); the next generation's start or a successful write clears it. */
  private readonly finalizedWorkers = new Map<string, string>();
  /** Kept here: the callbacks of `proveRunTermination` calls in flight, not per-run memory. */
  private readonly terminationWaiters = new Set<() => void>();

  beginWorkerExecution(runId: string, admitted = true): void {
    if (this.context.store.getRun(runId)?.delegation?.role !== 'worker') return;
    if (this.host.maintenance(runId)) throw new WorkerAdmissionRefusal('Worker resources are being cleaned up', 'retry the same command after the cleanup ends');
    // #469: one site for Continue, --resume, parent replies and queued revival after a crash.
    // Fresh: admission is one-shot, so a cached "alive" must not refuse an orphan that has since died.
    // A crashed controller's leftovers end here, so Continue starts in a scope nothing old runs in.
    if (!this.executions.has(runId)) {
      this.orphans.stopCrashedGeneration(runId);
      this.host.settleOrphanedWorkerExecution(runId, { admitting: true, fresh: true });
    }
    const refusal = this.executions.has(runId) ? undefined : this.orphans.orphanAdmissionRefusal(runId);
    if (refusal) throw refusal;
    const existing = this.executions.get(runId);
    if (existing) {
      const proof = this.context.store.readWorkerExecution(runId);
      if (!existing.admitted && admitted && proof?.generation === existing.generation && proof.phase === 'starting') {
        existing.admitted = true; return;
      }
      throw new WorkerAdmissionRefusal("the worker's previous execution is still finishing", 'retry the same command in a few seconds');
    }
    const generation = this.context.store.commitWorkerExecutionStart(runId);
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    this.executions.set(runId, { generation, admitted, promise, resolve, sessions: new Set(), turns: new Set(), deliveries: new Set() });
    this.finalizedWorkers.delete(runId);
    // #469: an earlier generation's destroy blocker never describes this one.
    this.orphans.forgetBlockers(runId);
    this.memory.write(runId, 'workerStopped', undefined);
  }

  async finishWorkerExecution(runId: string): Promise<void> {
    return this.context.work.track('finishWorkerExecution', this.finishWorkerExecutionWork(runId));
  }

  private async finishWorkerExecutionWork(runId: string): Promise<void> {
    const execution = this.executions.get(runId);
    if (!execution) return;
    await Promise.allSettled([...execution.sessions]);
    await Promise.allSettled([...execution.turns]);
    await Promise.allSettled([...execution.deliveries]);
    // Every wrapper settles after runner result, workflow and final filesystem work.
    // A disposed manager cannot attest to the recovered generation's state.
    if (!this.context.disposed()) {
      this.finalizedWorkers.set(runId, execution.generation);
      this.persistWorkerCompletion(runId, execution.generation);
    }
    if (this.executions.get(runId) === execution) this.executions.delete(runId);
    execution.resolve();
    if (!this.context.disposed()) {
      try { this.host.queueWaitWake(runId); } catch { this.host.retryWaitAdmission(runId); }
    }
    if (!this.context.disposed() && this.context.store.getRun(runId)?.stopping) this.context.store.updateRun(runId, { stopping: undefined });
    if (!this.context.disposed()) this.host.releaseSlot();
    if (!this.context.disposed()) this.host.releaseRunMemory(runId);
  }

  /** Capture every returned process result before setup can throw. A setup
   * exception or an interrupt request cannot stand in for session termination. */
  trackWorkerSessionResult(runId: string, session: AgentSession): Promise<void> {
    const closed = session.result.then(() => undefined, () => undefined);
    this.executions.get(runId)?.sessions.add(closed);
    return this.context.work.trackSession(session, closed);
  }

  private persistWorkerCompletion(runId: string, generation: string): void {
    try {
      if (this.isStopped(runId)) this.context.store.move(runId, 'stop-worker');
      if (this.context.store.commitWorkerExecutionComplete(runId, generation)) {
        this.finalizedWorkers.delete(runId);
        this.host.reapTerminalScratch(runId);
      }
    } catch { /* Finalized in this process; preserve exact generation for an explicit retry. */ }
  }

  /** Best effort: the session's scope holds it either way (ADR 0032); the record lets a restarted
   *  controller tell whether a crashed generation's session still runs. */
  recordWorkerProcess(runId: string, pid: number): void {
    const generation = this.executions.get(runId)?.generation;
    if (!generation) return;
    try { if (!this.context.store.appendWorkerProcess(runId, generation, pid, sessionGroupOf(pid))) console.warn(`${logPrefix()} worker ${runId} process record unavailable; its scope still holds the process`); }
    catch { console.warn(`${logPrefix()} worker ${runId} process record write failed; its scope still holds the process`); }
  }

  async proveRunTermination(runId: string, timeoutMs: number, opts: { reapOrphans?: boolean }): Promise<boolean> {
    const execution = this.executions.get(runId);
    if (!execution) {
      const generation = this.finalizedWorkers.get(runId);
      if (!this.context.disposed() && generation) this.persistWorkerCompletion(runId, generation);
      else if (!generation && opts.reapOrphans) await this.orphans.reapOrphanedWorker(runId, timeoutMs);
      else if (!generation) this.host.settleOrphanedWorkerExecution(runId);
      return this.context.store.readWorkerExecution(runId)?.phase === 'complete';
    }
    if (this.context.disposed()) return false;
    await new Promise<void>(resolve => {
      const settle = () => { clearTimeout(timer); this.terminationWaiters.delete(settle); resolve(); };
      // A local awaited pause of this caller, not a liveness bound of the run.
      // ast-grep-ignore: liveness-timer-outside-owner
      const timer = setTimeout(settle, Math.min(30_000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0)));
      this.terminationWaiters.add(settle);
      void execution.promise.then(settle);
    });
    return !this.executions.has(runId) && this.context.store.readWorkerExecution(runId)?.phase === 'complete';
  }

  has(id: string) { return this.executions.has(id); }
  admitted(id: string) { return this.executions.get(id)?.admitted; }
  generation(id: string) { return this.executions.get(id)?.generation; }
  markStopped(id: string) { this.memory.write(id, 'workerStopped', true); }
  isStopped(id: string) { return this.memory.read(id, 'workerStopped') === true; }
  trackTurn(id: string, task: Promise<void>) {
    const turns = this.executions.get(id)?.turns;
    turns?.add(task);
    void task.catch(() => undefined).finally(() => turns?.delete(task));
  }
  trackDelivery(id: string, task: Promise<void>) {
    const deliveries = this.executions.get(id)?.deliveries;
    deliveries?.add(task);
    void task.then(() => deliveries?.delete(task));
  }
  dispose() { this.finalizedWorkers.clear(); for (const settle of this.terminationWaiters) settle(); }
}
