/**
 * The worker-results topic of the run store (hearsay-tools/squawk#4038): the saved snapshot of a
 * worker's collected result, its path, the read checks and the commit. `RunStore` keeps one of
 * these as `store.workerResults`; the commit itself is `runs/worker-result-commit.ts`.
 */
import type { DelegationState, RunRecord, WorkerCollectedResult } from '@open-mercato/cezar-contract';
import { workerResultFileSchema } from '@open-mercato/cezar-contract/delegation';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { runDataDir } from '../project-paths.ts';
import { upgradeRemovedRunnerResult } from './legacy-run-rows.ts';
import type { WorkerResults } from './ports.ts';
import { bindWorkerResultPath, workerResultsDirectory } from './project-run-sources.ts';
import { commitStoreWorkerResult } from './worker-result-commit.ts';

/** What the topic asks of the store; no import of `store.ts`. */
export interface WorkerResultsState {
  peek(id: string): RunRecord | undefined;
  hasRun(id: string): boolean;
  hasFallbackRun(id: string): boolean;
  writeDir(id: string): string;
  sourceDataDir(id: string): string;
  /** The result as the store's redaction leaves it. */
  redactResult(value: WorkerCollectedResult): WorkerCollectedResult;
  redactText(text: string): string;
  commitDelegation(patches: ReadonlyArray<{ id: string; delegation: DelegationState }>): void;
}

export class WorkerResultsTopic implements WorkerResults {
  constructor(private readonly dataDir: string, private readonly state: WorkerResultsState) {}

  private workerResultsDir(parentId: string, write = false): string { return workerResultsDirectory(write ? this.state.writeDir(parentId) : this.state.sourceDataDir(parentId), parentId, write); }

  workerResultSnapshotPath(parentId: string, workerId: string, snapshotId: string): string {
    return join(runDataDir(this.dataDir, parentId), 'runs', `${z.uuid().parse(parentId)}-worker-results`, `${z.uuid().parse(workerId)}.${z.uuid().parse(snapshotId)}.json`);
  }

  private readWorkerResultFile(parentId: string, workerId: string): z.infer<typeof workerResultFileSchema> | undefined {
    const parent = this.state.peek(parentId);
    if (parent?.delegation?.role !== 'root' || !parent.delegation.receipts.some(receipt => receipt.workerId === workerId)) return undefined;
    const reference = parent.delegation.results?.find(result => result.workerId === workerId);
    if (!reference) return undefined;
    try {
      const path = join(this.workerResultsDir(parentId), `${z.uuid().parse(workerId)}.${z.uuid().parse(reference.snapshotId)}.json`);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw: string;
      try { const info = fstatSync(fd); if (!info.isFile() || info.size > 3_145_728) return undefined; raw = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
      const file = workerResultFileSchema.parse(upgradeRemovedRunnerResult(JSON.parse(raw)));
      if (!bindWorkerResultPath(file.result.diff, this.dataDir, this.state.hasFallbackRun(parentId), parentId, path)) return undefined;
      if (file.result.parentRunId !== parentId || file.result.workerId !== workerId || file.result.workspace.ownerRunId !== workerId || file.result.revision !== reference.revision || file.result.observedAt !== reference.observedAt ||
        (file.result.diff.state === 'available' && (file.result.diff.snapshotId !== reference.snapshotId || file.diffSnapshot === undefined))) return undefined;
      return file;
    } catch { return undefined; }
  }

  readWorkerResult(parentId: string, workerId: string): WorkerCollectedResult | undefined {
    return this.readWorkerResultFile(parentId, workerId)?.result;
  }
  readWorkerResultDiff(parentId: string, workerId: string): string | undefined {
    return this.readWorkerResultFile(parentId, workerId)?.diffSnapshot;
  }

  /** Publish a pointer only after its redacted immutable snapshot reaches disk. */
  commitWorkerResult(parentId: string, value: WorkerCollectedResult, diffSnapshot?: string, opts: { ignoreCleanup?: boolean } = {}): WorkerCollectedResult {
    return commitStoreWorkerResult({
      redactResult: (result) => this.state.redactResult(result),
      peek: (id) => this.state.peek(id),
      readWorkerResultFile: (id, workerId) => this.readWorkerResultFile(id, workerId),
      readWorkerResult: (id, workerId) => this.readWorkerResult(id, workerId),
      redactText: (text) => this.state.redactText(text),
      workerResultSnapshotPath: (id, workerId, snapshotId) => this.workerResultSnapshotPath(id, workerId, snapshotId),
      workerResultsDir: (id) => this.workerResultsDir(id, true),
      commitDelegation: (patches) => this.state.commitDelegation(patches),
    }, parentId, value, diffSnapshot, opts);
  }

  /** Complete replacement evidence can stand in for absent child history, never for a present execution. */
  readDeletedWorkerResult(parentId: string, workerId: string): WorkerCollectedResult | undefined {
    if (this.state.hasRun(workerId)) return undefined;
    const parent = this.state.peek(parentId);
    if (parent?.delegation?.role !== 'root' || parent.delegation.historyDeletion) return undefined;
    const deletion = parent.delegation.receipts.find(receipt => receipt.workerId === workerId)?.deletion;
    if (deletion?.phase !== 'complete') return undefined;
    const result = this.readWorkerResult(parentId, workerId);
    return result?.settled && ['review', 'done', 'failed', 'cancelled'].includes(result.status) &&
      result.cleanup === 'complete' && result.revision === deletion.revision &&
      result.workspace.resourceId === deletion.resourceId ? result : undefined;
  }
}
