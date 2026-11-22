import type { RunModuleContext, WorkerTerminationBlocker } from './types.ts';
import { noJitter, ORPHAN_BACKOFF, retryDelayMs, type Backoff } from '../../delegation/retry-backoff.ts';
import { isCurrentProcess, recordedProcessLive, type WorkerProcessRecord } from '../../core/process-stat.ts';
import { controllerRefusal, WorkerAdmissionRefusal } from '../../runs/worker-execution.ts';

type OrphanOptions = { admitting?: boolean; fresh?: boolean };
interface WorkerOrphansHost {
  holds(runId: string, admitting: boolean): boolean;
  reapTerminalScratch(runId: string): void;
  settleOrphanedWorkerExecution(runId: string, opts?: OrphanOptions): boolean;
}

/** What still runs of a crashed generation: its live recorded controller, else its live recorded
 * session processes. Only the record decides; nothing scans the host (ADR 0032). */
type OrphanProbe = { liveness: 'gone' } | { liveness: 'alive'; controller?: number; pids: number[] };

function probeOrphan(record: WorkerProcessRecord | undefined): OrphanProbe {
  if (!record) return { liveness: 'gone' };
  if (!isCurrentProcess(record.controller) && recordedProcessLive(record.controller)) return { liveness: 'alive', controller: record.controller.pid, pids: [] };
  const pids = record.processes.filter(recordedProcessLive).map(entry => entry.pid);
  return pids.length ? { liveness: 'alive', pids } : { liveness: 'gone' };
}

export class WorkerOrphans {
  orphanBackoff: Backoff = ORPHAN_BACKOFF;
  constructor(private readonly context: RunModuleContext, private readonly host: WorkerOrphansHost) {}

  forgetBlockers(runId: string): void {
    this.orphanBlockers.delete(runId); this.reportedOrphanBlockers.delete(runId);
  }

  dispose(): void {
    this.orphanDue.clear(); clearTimeout(this.orphanTimer); this.orphanTimer = undefined;
    this.orphanBlockers.clear(); this.reportedOrphanBlockers.clear();
  }

  /** #469: the generation a dead controller left `starting`, if this manager may judge it. A
   * generation this process controls is never judged here: the in-memory execution map owns it,
   * and a disposed manager's still-running sessions look like orphans. `busy` is transient (this
   * manager holds the run); `unknown` is a present record that proves nothing. */
  private orphanState(runId: string, admitting = false):
    | { state: 'none' | 'busy' | 'unknown' }
    | { state: 'orphan'; generation: string; record?: WorkerProcessRecord } {
    const run = this.context.store.getRun(runId);
    if (run?.delegation?.role !== 'worker' || this.context.disposed()) return { state: 'none' };
    if (this.host.holds(runId, admitting)) return { state: 'busy' };
    const proof = this.context.store.workerExecutions.readWorkerExecution(runId);
    if (proof?.phase !== 'starting') return { state: 'none' };
    const record = this.context.store.workerExecutions.readWorkerProcesses(runId, proof.generation);
    // A present record that proves nothing (unreadable, malformed, another generation) blocks
    // finalization; an absent one is a generation from before process records, with nothing to wait for.
    if (record === 'unknown') return { state: 'unknown' };
    if (record !== 'absent' && isCurrentProcess(record.controller)) return { state: 'none' };
    return { state: 'orphan', generation: proof.generation, ...(record === 'absent' ? {} : { record }) };
  }

  orphanedWorkerGeneration(runId: string, admitting = false) {
    const orphan = this.orphanState(runId, admitting);
    return orphan.state === 'orphan' ? orphan : undefined;
  }

  /** Settles a crashed generation once its recorded processes are gone. Sync and signal-free;
   * recovery, resume, delivery, collect and destroy then take their normal paths. */
  settleOrphanedWorkerExecution(runId: string, opts: OrphanOptions = {}): boolean {
    const orphan = this.orphanedWorkerGeneration(runId, opts.admitting);
    if (!orphan) return false;
    const probe = probeOrphan(orphan.record);
    if (probe.liveness !== 'gone') { this.orphanProbes.set(runId, { generation: orphan.generation, probe }); return false; }
    this.orphanProbes.delete(runId);
    try {
      if (!this.context.store.workerExecutions.commitWorkerExecutionComplete(runId, orphan.generation, { interrupted: true })) return false;
    } catch { return false; }
    this.orphanBlockers.delete(runId); this.reportedOrphanBlockers.delete(runId); this.orphanDue.delete(runId);
    this.context.store.eventLog.appendEvent(runId, { type: 'lifecycle', message: "the interrupted worker's processes are gone; its execution was finalized" });
    this.host.reapTerminalScratch(runId);
    return true;
  }

  // The orphan maps stay here, not in `RunMemory`: each entry describes one worker generation and
  // goes when that generation settles or a new one starts (ADR 0064).
  private readonly orphanProbes = new Map<string, { generation: string; probe: OrphanProbe }>();
  /** Pending orphan reprobes by run id. One timer serves them all (hearsay-tools/cezarion#879). */
  readonly orphanDue = new Map<string, { generation: string; at: number; attempts: number }>();
  private orphanTimer?: NodeJS.Timeout | undefined;
  /** The `at` the timer was armed for; with the clock, it decides what a tick takes. */
  private orphanArmedFor = 0;
  private readonly orphanBlockers = new Map<string, WorkerTerminationBlocker>();
  private readonly reportedOrphanBlockers = new Map<string, string>();

  /** #469: a survivor that dies after recovery has no other wake source (no exit callback for a
   * process another Squawk spawned). Unref'd; finalization's `run` event then lets worker waits and
   * outcomes observe it. Every 15 s for the first 15 minutes, then backing off to hourly
   * (hearsay-tools/cezarion#879). A tick while this manager holds the run is skipped; only terminal
   * reasons (proof settled, generation changed, run gone, unknown record, dispose) stop it. */
  armOrphanReprobe(runId: string): void {
    const armed = this.orphanedWorkerGeneration(runId);
    if (this.context.disposed() || this.orphanDue.has(runId) || !armed) return;
    this.orphanDue.set(runId, { generation: armed.generation, at: Date.now() + retryDelayMs(0, this.orphanBackoff, noJitter), attempts: 0 });
    this.wakeOrphanReprobes();
  }

  private wakeOrphanReprobes(): void {
    clearTimeout(this.orphanTimer); this.orphanTimer = undefined;
    if (this.context.disposed() || !this.orphanDue.size) return;
    let next = Infinity;
    for (const { at } of this.orphanDue.values()) next = Math.min(next, at);
    this.orphanArmedFor = next;
    this.orphanTimer = setTimeout(() => this.orphanReprobeTick(), Math.max(0, next - Date.now()));
    this.orphanTimer.unref?.();
  }

  private orphanReprobeTick(): void {
    this.orphanTimer = undefined;
    if (this.context.disposed()) return;
    // Orphans due within 5 % of the fast cadence ride along, and every orphan this tick keeps is
    // re-armed from the same instant, so they stay together.
    const now = Date.now();
    const dueBy = Math.max(this.orphanArmedFor, now) + this.orphanBackoff.fastMs / 20;
    for (const [runId, pending] of [...this.orphanDue]) {
      if (pending.at > dueBy) continue;
      this.orphanDue.delete(runId);
      const orphan = this.orphanState(runId);
      let attempts = pending.attempts;
      if (orphan.state !== 'busy') {
        if (orphan.state !== 'orphan' || orphan.generation !== pending.generation ||
          this.host.settleOrphanedWorkerExecution(runId, { fresh: true })) continue;
        attempts++;
      }
      this.orphanDue.set(runId, { ...pending, attempts, at: now + retryDelayMs(attempts, this.orphanBackoff, noJitter) });
    }
    this.wakeOrphanReprobes();
  }

  /** Why the last destroy could not prove termination (#469), and whether that differs from the
   * reason last reported, so a retry loop appends one lifecycle event per distinct blocker set. */
  takeWorkerTerminationBlocker(runId: string): { blocker: WorkerTerminationBlocker; changed: boolean } | undefined {
    const blocker = this.orphanBlockers.get(runId);
    if (!blocker) return undefined;
    const key = JSON.stringify(blocker);
    const changed = this.reportedOrphanBlockers.get(runId) !== key;
    this.reportedOrphanBlockers.set(runId, key);
    return { blocker, changed };
  }

  /** Continue refuses only while another live Squawk controls the worker. Processes a crashed
   * controller left are stopped by Continue itself (`stopCrashedGeneration`). */
  orphanAdmissionRefusal(runId: string): WorkerAdmissionRefusal | undefined {
    const orphan = this.orphanedWorkerGeneration(runId, true);
    const probe = orphan && this.orphanProbes.get(runId);
    if (!probe || probe.generation !== orphan.generation || probe.probe.liveness !== 'alive' || probe.probe.controller === undefined) return undefined;
    return controllerRefusal(probe.probe.controller);
  }

  /** Continue after a controller crash: end everything the worker's scope holds, then wait (up to
   * `waitMs`, synchronously: admission is synchronous) for the recorded processes to be gone. The
   * crashed generation may still be `starting`, or already settled as `interrupted` by recovery;
   * a generation that finished normally keeps its services. Does nothing while another live
   * controller owns the generation. */
  stopCrashedGeneration(runId: string, waitMs = 2_000): void {
    const orphan = this.orphanedWorkerGeneration(runId, true);
    const probe = orphan ? probeOrphan(orphan.record) : undefined;
    if (probe?.liveness === 'alive' && probe.controller !== undefined) return;
    const proof = orphan ? undefined : this.context.store.workerExecutions.readWorkerExecution(runId);
    if (!orphan && !(proof?.phase === 'complete' && proof.interrupted)) return;
    if (probe?.liveness !== 'alive' && this.context.store.workerExecutions.scopes.empty(runId)) return;
    this.context.store.workerExecutions.scopes.kill(runId);
    this.context.store.eventLog.appendEvent(runId, { type: 'lifecycle', message: "Continue stopped the processes the interrupted worker's previous execution left running" });
    // Nothing new starts until the old processes are gone, so none keeps a port or a file.
    const deadline = Date.now() + waitMs;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const stopped = () => (!orphan || probeOrphan(orphan.record).liveness === 'gone') && this.context.store.workerExecutions.scopes.stopped(runId);
    while (!stopped() && Date.now() < deadline) Atomics.wait(pause, 0, 0, 5);
    if (!stopped()) throw new WorkerAdmissionRefusal("the processes the interrupted execution left are still stopping", 'retry the same command in a few seconds');
  }

  /** Destroy only (#469): end everything the worker's scope holds, then finalize once the recorded
   * processes are gone. A live foreign controller's generation is not ours to stop. */
  async reapOrphanedWorker(runId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.min(30_000, Math.max(0, Number.isFinite(timeoutMs) ? timeoutMs : 0));
    this.orphanBlockers.delete(runId);
    const initial = this.orphanState(runId);
    if (initial.state === 'unknown') { this.orphanBlockers.set(runId, { kind: 'unreadable' }); return; }
    const orphan = this.orphanedWorkerGeneration(runId);
    if (!orphan || this.host.settleOrphanedWorkerExecution(runId, { fresh: true })) return;
    const same = () => this.orphanedWorkerGeneration(runId)?.generation === orphan.generation;
    const probe = probeOrphan(orphan.record);
    // A live controller is another Squawk's: nothing to stop or wait for.
    if (probe.liveness === 'alive' && probe.controller !== undefined) {
      this.orphanBlockers.set(runId, { kind: 'controller', pid: probe.controller });
      return;
    }
    if (probe.liveness === 'alive') this.context.store.workerExecutions.scopes.kill(runId);
    while (!this.host.settleOrphanedWorkerExecution(runId, { fresh: true }) && Date.now() < deadline && same()) {
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(50, deadline - Date.now()))));
    }
    if (!same()) return;
    const last = this.orphanProbes.get(runId)?.probe;
    if (last?.liveness !== 'alive') return;
    if (last.controller !== undefined) this.orphanBlockers.set(runId, { kind: 'controller', pid: last.controller });
    else if (last.pids.length) this.orphanBlockers.set(runId, { kind: 'processes', pids: last.pids });
  }
}
