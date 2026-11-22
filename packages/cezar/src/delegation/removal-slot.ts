import type { ReclaimPreparation } from '../runs/removal-slots.ts';
import type { RunRecord, RunStore } from '../runs/store.ts';
import type { WorkerResults } from '../runs/ports.ts';
import { collectWorkerEvidence } from './results.ts';

/** Snapshot parent-owned worker evidence before the checkout goes. A collect/commit failure
 *  returns false so the directory is left for the next pass. */
async function preserveWorkerResult(repoRoot: string, store: { readonly workerResults: WorkerResults }, run: RunRecord): Promise<boolean> {
  if (run.delegation?.role !== 'worker') return true;
  const evidence = await collectWorkerEvidence(repoRoot, store as RunStore, run);
  store.workerResults.commitWorkerResult(run.delegation.parentRunId, evidence.result, evidence.diffSnapshot);
  return evidence.diffSnapshot !== undefined || evidence.result.diff.state === 'available';
}

/** The reclaim preparation of workers: an owned worker's evidence is saved before its worktree goes.
 *  A worker whose evidence could not be saved keeps its worktree until the next pass. */
export const workerEvidencePreparation: ReclaimPreparation = {
  name: 'worker evidence',
  async prepare(run, { repoRoot, store }) {
    if (!(await preserveWorkerResult(repoRoot, store, run))) throw new Error('Worker evidence was not saved');
  },
};
