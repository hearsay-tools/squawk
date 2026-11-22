/**
 * The retention and deletion topic of the run store (hearsay-tools/squawk#4037): whether a run's
 * history or worktree may go, the deletion itself (plain and delegated), the history files a
 * committed delete still owes, and the count-based archive of settled families. It asks the
 * removal slots (`runs/removal-slots.ts`) on every path. `RunStore` keeps one of these as
 * `store.retention`; worktree retention is `runs/retention.ts`.
 */
import type { DelegationState, RunRecord } from '@open-mercato/cezar-contract';
import { RETENTION_RUN_RULE } from '@open-mercato/cezar-contract/run-predicates';
import { randomUUID } from 'node:crypto';
import { realpathSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { dataReadDirs, runDataDir } from '../project-paths.ts';
import { agentTmpDirMayExist, removeAgentTmpDir } from './agent-tmpdir.ts';
import { guardedJsonSql } from './guarded-json-sql.ts';
import { removeHistory } from './history-file.ts';
import type { RunLifecycle } from './lifecycle.ts';
import type { RunRetention, WorkerResults } from './ports.ts';
import { fallbackRunDeleteError } from './project-run-sources.ts';
import { assertRunSlotsSealed, deletionRefusal, runRemovalCleanups } from './removal-slots.ts';
import { familyKey, rowFamily } from './run-claims.ts';
import type { RunDatabase } from './run-database.ts';
import { isLiveRecord, newestFirst, type ListOrder } from './run-row.ts';
import { supervisedWorkers } from './supervised.ts';
import type { RunTranscriptFacts } from './transcript-facts-topic.ts';
import { workerEvidenceRunIds, type WorkerExecution } from './worker-execution.ts';

const MAX_RUNS_KEPT = 300;

/** What the topic asks of the store; no import of `store.ts`. */
export interface RetentionState {
  /** The open database; null for an unavailable or closed store. */
  db(): RunDatabase | null;
  readonly held: Map<string, RunRecord>;
  readonly deleted: ReadonlySet<string>;
  readonly quarantined: ReadonlySet<string>;
  readonly historyOwed: Set<string>;
  readonly seqs: Map<string, number>;
  readonly published: RunLifecycle;
  readonly transcriptFacts: RunTranscriptFacts;
  peek(id: string): RunRecord | undefined;
  hasRun(id: string): boolean;
  record(id: string): RunRecord | undefined;
  listWorkersOf(parentId: string): RunRecord[];
  isFallbackRun(id: string): boolean;
  hasFallbackRun(id: string): boolean;
  listOrder(run: RunRecord): ListOrder;
  claimFamilies(families: Iterable<string>): Set<string>;
  markDeleted(id: string, family: string): void;
  scheduleSave(): void;
  commitIndex(input: ReadonlyMap<string, RunRecord | null>): void;
  commitDelegation(patches: ReadonlyArray<{ id: string; delegation: DelegationState }>): void;
  applyArchived(run: RunRecord, archived: boolean): boolean;
  /** The worker deletion checks, in today's order (`store.workerExecutions`, hearsay-tools/squawk#4039). */
  workerDeletionEvidence(id: string): boolean;
  readonly workerResults: WorkerResults;
  readWorkerExecution(id: string): WorkerExecution | undefined;
  identityPath(id: string): string;
  processesPath(id: string): string;
  scopePath(id: string): string;
  executionPath(id: string): string;
  sourceDataDir(id: string): string;
}

export class RunRetentionTopic implements RunRetention {
  constructor(private readonly dataDir: string, private readonly state: RetentionState) {}

  fallbackDeleteError(id: string, kind: 'record' | 'worktree' = 'record'): string | undefined { return fallbackRunDeleteError(this.dataDir, kind === 'record' ? this.state.hasFallbackRun(id) : this.state.isFallbackRun(id), this.state.peek(id)?.worktreePath); }

  canDeleteRun(id: string, kind: 'record' | 'worktree' = 'record'): boolean {
    if (this.fallbackDeleteError(id, kind)) return false;
    if (deletionRefusal(id, kind === 'record' ? 'history' : 'worktree', this.dataDir)) return false;
    const run = this.state.peek(id);
    if (run?.delegation?.role === 'invalid') return false;
    if (run?.delegation?.role === 'worker') return supervisedWorkers(this.state, run).length === 0 && this.state.workerDeletionEvidence(id);
    const privateWorkers = workerEvidenceRunIds(this.dataDir);
    if (!privateWorkers || privateWorkers.includes(id)) return false;
    if (run?.delegation?.role === 'root') {
      if (run.delegation.finishRequestedAt && ['queued', 'running', 'waiting'].includes(run.status)) return false;
      // Keep the parent's receipt and result ownership until each child history is explicitly removed.
      if (this.state.listWorkersOf(id).length > 0) return false;
      return run.delegation.receipts.every(receipt => {
        if (this.state.hasRun(receipt.workerId) || receipt.deletion?.phase !== 'complete') return false;
        // A pending parent deletion already validated the results before removing their bytes.
        if (run.delegation?.role === 'root' && run.delegation.historyDeletion === 'pending') return true;
        return this.state.workerResults.readDeletedWorkerResult(id, receipt.workerId) !== undefined;
      });
    }
    return this.state.listWorkersOf(id).length === 0;
  }

  /** Delegated history deletion is synchronous and checkpointed; any failed byte/index removal remains retryable. */
  private deleteDelegatedRun(id: string): boolean {
    const run = this.state.peek(id)!;
    try {
      if (run.delegation?.role === 'worker') {
        const parent = this.state.peek(run.delegation.parentRunId)!;
        if (parent.delegation?.role !== 'root') return false;
        const receipt = parent.delegation.receipts.find(entry => entry.workerId === id)!;
        const result = this.state.workerResults.readWorkerResult(parent.id, id)!;
        const deletion = receipt.deletion ?? { phase: 'pending' as const, revision: result.revision,
          resourceId: run.delegation.workspace.resourceId, generation: this.state.readWorkerExecution(id)!.generation };
        this.state.commitDelegation([{ id: parent.id, delegation: { ...parent.delegation,
          receipts: parent.delegation.receipts.map(entry => entry.workerId === id ? { ...entry, deletion } : entry),
        } }]);
        // Do not advertise artifact bytes as retained while interrupted deletion is in progress.
        this.state.workerResults.commitWorkerResult(parent.id, { ...result, observedAt: new Date().toISOString(),
          diff: result.diff.state === 'available' ? { ...result.diff, snapshotId: randomUUID() } : result.diff,
          artifacts: result.artifacts.state === 'available' ? { ...result.artifacts,
            items: result.artifacts.items.map(item => ({ state: 'unavailable' as const, reason: 'unreadable' as const,
              detail: 'History deletion is in progress', id: item.id, path: item.path })),
          } : result.artifacts,
        }, this.state.workerResults.readWorkerResultDiff(parent.id, id));
        this.removeRunHistoryBytes(id);
        // Delete scratch while its generation evidence still exists; failed removal keeps it.
        removeAgentTmpDir(this.dataDir, id);
        if (agentTmpDirMayExist(this.dataDir, id)) return false;
        // Private process/account evidence is now replaced by the exact parent receipt.
        rmSync(this.state.identityPath(id), { force: true });
        rmSync(this.state.processesPath(id), { force: true });
        rmSync(this.state.scopePath(id), { force: true });
        rmSync(this.state.executionPath(id), { force: true });
        const retained = this.state.workerResults.readWorkerResult(parent.id, id)!;
        this.state.workerResults.commitWorkerResult(parent.id, { ...retained, observedAt: new Date().toISOString(),
          diff: retained.diff.state === 'available' ? { ...retained.diff, snapshotId: randomUUID() } : retained.diff,
          artifacts: retained.artifacts.state === 'available' ? { ...retained.artifacts,
            items: retained.artifacts.items.map(item => ({ state: 'deleted' as const, reason: 'missing' as const, id: item.id, path: item.path })),
          } : retained.artifacts,
        }, this.state.workerResults.readWorkerResultDiff(parent.id, id));
        this.state.commitIndex(new Map<string, RunRecord | null>([[parent.id, { ...parent, delegation: { ...parent.delegation,
          receipts: parent.delegation.receipts.map(entry => entry.workerId === id ? { ...entry, deletion: { ...deletion, phase: 'complete' as const } } : entry),
        } }], [id, null]]));
      } else if (run.delegation?.role === 'root') {
        this.state.commitDelegation([{ id, delegation: { ...run.delegation, historyDeletion: 'pending' } }]);
        this.removeRunHistoryBytes(id);
        rmSync(join(runDataDir(this.dataDir, id), 'runs', `${id}-worker-results`), { recursive: true, force: true });
        this.state.commitIndex(new Map([[id, null]]));
      } else return false;
      removeAgentTmpDir(this.dataDir, id);
      this.state.seqs.delete(id);
      return true;
    } catch { return false; }
  }

  private removeRunHistoryBytes(id: string): void {
    // Fixed owned paths only: never follow context descriptors supplied in persisted metadata.
    z.uuid().parse(id);
    const dir = join(runDataDir(this.dataDir, id), 'runs');
    if (realpathSync(dir) !== resolve(dir)) throw new Error('History storage redirected');
    this.removeHistoryFiles(id);
  }

  /** The run's history, handoff and images, then the removal cleanups (`runs/removal-slots.ts`). */
  private removeHistoryFiles(id: string): void {
    this.state.transcriptFacts.index.forget(id);
    removeHistory(this.dataDir, id);
    rmSync(this.handoffPath(id), { force: true });
    rmSync(this.imagesDir(id), { recursive: true, force: true });
    runRemovalCleanups(id, this.dataDir);
  }

  deleteRun(id: string): boolean {
    const refusal = this.fallbackDeleteError(id);
    if (refusal) throw new Error(refusal);
    if (!this.canDeleteRun(id)) return false;
    const run = this.state.peek(id);
    if (run && this.state.db() && (this.state.quarantined.has(id) || !this.state.claimFamilies([familyKey(run)]).size)) return false;
    if (run?.delegation?.role === 'worker' || run?.delegation?.role === 'root') return this.deleteDelegatedRun(id);
    const existed = run !== undefined;
    this.state.held.delete(id);
    if (existed) {
      this.state.markDeleted(id, familyKey(run));
      removeAgentTmpDir(this.dataDir, id);
      this.state.seqs.delete(id);
      this.state.scheduleSave();
      this.state.published.publish('run.deleted', { runId: id });
    }
    return existed;
  }

  /** A deleted run's history files and removal cleanups, once the delete of its row has committed.
   *  Best effort: a failure is logged, and the row stays deleted. */
  removeOwedHistory(id: string): void {
    if (!this.state.historyOwed.delete(id)) return;
    try { this.removeHistoryFiles(id); } catch (error) {
      console.warn(`[hsq] History cleanup of run ${id} is incomplete: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Count-based history retention: of the runs past the newest `MAX_RUNS_KEPT` unarchived ones,
   * archive each settled task that is not pinned and whose family this store can claim, together
   * with its workers, once no member of the family is live (hearsay-tools/squawk#777). Ranked over the row keys (the `created_at` index, no record decoded) with memory
   * laid over them, since a run created or archived since the last save has no row yet; the rows
   * past the cut are then filtered in `runs.db`, so only real candidates decode. Archived runs
   * are never deleted by retention — only an explicit delete, worker destruction, or history
   * deletion removes a run.
   */
  pruneOldRuns(): void {
    const ranked = new Map<string, ListOrder & { id: string }>();
    for (const key of this.state.db()?.listKeysWhere('archived = ?', [0]) ?? []) {
      if (!this.state.held.has(key.id) && !this.state.deleted.has(key.id)) ranked.set(key.id, key);
    }
    for (const run of this.state.held.values()) if (!run.archived) ranked.set(run.id, { id: run.id, ...this.state.listOrder(run) });
    const overflow = [...ranked.values()].sort(newestFirst).slice(MAX_RUNS_KEPT).map((key) => key.id);
    if (overflow.length === 0) return;
    const stale = overflow.flatMap((id) => {
      const run = this.state.held.get(id);
      // Retention must not archive a live task between turns, a pinned run, or a worker on its own.
      return run && !this.state.hasFallbackRun(id) && RETENTION_RUN_RULE.matches(run) ? [id] : [];
    });
    const skipped = overflow.filter(id => this.state.hasFallbackRun(id)).length;
    if (skipped) console.info(`[hsq] Retention skipped ${skipped} read-only fallback run(s) under ${dataReadDirs(this.dataDir)[1]}.`);
    const cold = overflow.filter((id) => !this.state.held.has(id) && !this.state.hasFallbackRun(id));
    if (cold.length > 0) {
      // Another process's runs are its own to keep or archive (#779, plan step 3).
      const rows = this.state.db()!.listWhere(guardedJsonSql(RETENTION_RUN_RULE.sql, 0), [JSON.stringify(cold)]);
      const writable = this.state.claimFamilies(rows.map(rowFamily));
      for (const row of rows) if (writable.has(rowFamily(row))) stale.push(row.id);
    }
    for (const id of stale) {
      const run = this.state.record(id);
      if (!run || run.archived || !RETENTION_RUN_RULE.matches(run)) continue;
      this.archiveSettledFamily(run);
    }
  }

  /** Archive a root with its workers unless a member is live, mid-destroy or pinned, or a history
   *  deletion is under way. Each member is marked dirty: the next save writes the family at once. */
  private archiveSettledFamily(root: RunRecord): void {
    assertRunSlotsSealed();
    const workers = this.state.listWorkersOf(root.id), family = [root, ...workers];
    if (family.some((run) => isLiveRecord(run) || run.pinned) || (root.delegation?.role === 'root' && root.delegation.historyDeletion)) return;
    for (const member of [root, ...workers.flatMap((worker) => this.state.record(worker.id) ?? [])].filter((run) => !run.archived)) {
      this.state.applyArchived(member, true);
      if (!deletionRefusal(member.id, 'archive-tmp', this.dataDir)) removeAgentTmpDir(this.dataDir, member.id);
    }
  }

  /** Same location `handoffPath()` in handoff.ts produces — inlined to keep
   *  the store free of upward imports. */
  private handoffPath(runId: string): string {
    return join(this.state.sourceDataDir(runId), 'runs', `${runId}.handoff.md`);
  }

  /** Agent screenshots persisted by the run manager (see persistImage). */
  private imagesDir(runId: string): string {
    return join(this.state.sourceDataDir(runId), 'runs', `${runId}-images`);
  }
}
