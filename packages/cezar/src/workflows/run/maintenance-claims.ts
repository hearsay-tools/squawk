import { isReclaimable, workerFamilyEnded } from '../../runs/retention.ts';
import { directoryRunId, hostsLiveSharedWorker } from '../../runs/shared-hosts.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { RunModuleContext } from './types.ts';

interface MaintenanceClaimsHost {
  isActive(runId: string): boolean;
  autosaveCleanupBlocker(runId: string): unknown;
  hasExecution(runId: string): boolean;
  scheduleScratchCleanup(runId: string): void;
  holdForMaintenance(runIds: readonly string[]): (() => void) | null;
}

export class MaintenanceClaims {
  /** Kept here, not in `RunMemory`: cleanup evidence that outlives an execution. A claim lives
   *  from its grant to the release callback its holder calls, so `dispose` keeps it. */
  readonly reclaiming = new Set<string>();
  constructor(private readonly context: RunModuleContext, private readonly host: MaintenanceClaimsHost) {}
  /** Whether the run's own resources are claimed. */
  has(runId: string): boolean { return this.reclaiming.has(runId); }

  /** Whether a claim holds the run off a start: its own, or one on the run whose directory it
   *  works in. Only the start paths ask this (Continue admission, leaving the line, the worker
   *  execution start), so a claim on a host's directory and the start of a worker in that directory
   *  exclude each other: the claim side asks `hostsLiveSharedWorker` in its own step. */
  blocksStart(runId: string): boolean {
    if (this.reclaiming.has(runId)) return true;
    let run: RunRecord | undefined;
    try { run = this.context.store.getRun(runId); } catch { return false; }
    return !!run && this.reclaiming.has(directoryRunId(run));
  }

  /** Hold off every admission path until destructive work (including async Git) completes. */
  claimWorkerCleanup(runId: string): (() => void) | undefined {
    if (this.context.disposed() || this.has(runId) || !!this.host.autosaveCleanupBlocker(runId) || this.host.isActive(runId) || this.host.hasExecution(runId)) return undefined;
    this.reclaiming.add(runId);
    return () => { this.reclaiming.delete(runId); this.host.scheduleScratchCleanup(runId); };
  }

  /** Why autosave cleanup evidence holds the run off a start: its own, or that of the run whose
   *  directory it works in, which marks that directory unsafe to reuse. The start paths ask this
   *  beside `blocksStart`; a read about the run's own scratch or execution asks for its own id. */
  autosaveStartBlocker(runId: string): string | undefined {
    const own = this.host.autosaveCleanupBlocker(runId);
    if (own) return String(own);
    let run: RunRecord | undefined;
    try { run = this.context.store.getRun(runId); } catch { return undefined; }
    const directory = run ? directoryRunId(run) : runId;
    const hosted = directory === runId ? undefined : this.host.autosaveCleanupBlocker(directory);
    return hosted ? String(hosted) : undefined;
  }

  /** A directory a live worker works in is not reclaimed, and its branch is not deleted. */
  private hostsLiveSharedWorker(run: RunRecord | undefined): boolean {
    return !!run && hostsLiveSharedWorker(run, (rootId) => this.context.store.queries.listWorkersOf(rootId));
  }

  /**
   * Claim a run's worktree for a reclaim (#483, issue 08 §B4), or null when it is in use or no
   * longer reclaimable. The check and the claim are one synchronous step, and `continueRun`
   * refuses a claimed run until the release, so a Continue can never resume into a directory a
   * forced removal is deleting — nor a removal start under a session that was just admitted.
   */
  claimWorktreeReclaim(runId: string): (() => void) | null {
    if (this.has(runId) || !!this.host.autosaveCleanupBlocker(runId) || this.host.isActive(runId) || this.context.store.claims.writeRefusal(runId)) return null;
    const run = this.context.store.getRun(runId);
    if (!run || !isReclaimable(run, (id) => this.context.store.getRun(id), (rootId) => this.context.store.queries.listWorkersOf(rootId))) return null;
    return this.host.holdForMaintenance([runId]);
  }

  /**
   * Hold `runIds` against Continue, reclaim, publish and branch cleanup here AND in every other
   * Squawk process for the length of an async operation (#779, plan step 3; PR #851 review). An
   * ownership check alone is a moment: pinning claims each run's family, so another process
   * cannot claim and Continue it while this one rematerializes, publishes or deletes. Null when
   * any hold fails (another process took the claim first); nothing stays held then.
   */
  holdForMaintenance(runIds: readonly string[]): (() => void) | null {
    // Only pin and reclaim together: a failed hold leaves nothing held.
    const pinned: string[] = [];
    for (const id of runIds) {
      if (!this.context.store.runPins.pin(id, 'maintenance')) {
        for (const done of pinned) this.context.store.runPins.unpin(done, 'maintenance');
        return null;
      }
      pinned.push(id);
    }
    for (const id of runIds) this.reclaiming.add(id);
    return () => {
      for (const id of runIds) { this.reclaiming.delete(id); this.context.store.runPins.unpin(id, 'maintenance'); }
    };
  }

  /**
   * Claim a settled run while its draft PR is published (`POST /runs/:id/pr`), or null when it is
   * live or already claimed. Publishing may first re-materialize a reclaimed checkout, which
   * clears the reclaim stamp and makes the run reclaimable again; held, the claim keeps reclaim,
   * branch cleanup and Continue off the checkout until the push and `gh` are done with it.
   */
  claimForPublish(runId: string): (() => void) | null {
    if (this.has(runId) || !!this.host.autosaveCleanupBlocker(runId) || this.host.isActive(runId) || this.context.store.claims.writeRefusal(runId)) return null;
    return this.host.holdForMaintenance([runId]);
  }

  /**
   * Claim every run that owns a branch about to be deleted (issue 08 §B3), or null when any is in
   * use: live, queued, at the review gate, or already claimed. The classification that allowed the
   * delete read liveness before awaiting git and GitHub; this re-reads it and holds Continue off —
   * its re-materialization would otherwise recreate the branch from the base under the delete.
   */
  claimForBranchCleanup(runIds: readonly string[]): (() => void) | null {
    const lookup = (id: string) => this.context.store.getRun(id);
    // A worker at review counts as settled once its family has ended (hearsay-tools/squawk#911).
    const unfinished = (id: string) => {
      const run = lookup(id);
      return !!run && !['done', 'failed', 'cancelled'].includes(run.status) && !(run.status === 'review' && workerFamilyEnded(run, lookup));
    };
    if (runIds.some((id) => this.has(id) || !!this.host.autosaveCleanupBlocker(id) || this.host.isActive(id) || unfinished(id) || this.hostsLiveSharedWorker(lookup(id)) || this.context.store.claims.writeRefusal(id))) return null;
    return this.host.holdForMaintenance(runIds);
  }

}
