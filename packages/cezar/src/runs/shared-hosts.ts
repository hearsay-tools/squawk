import { ownsDirectory } from '@open-mercato/cezar-contract/delegation';
import { isLiveRecord } from './run-row.ts';
import type { RunRecord } from './store.ts';

/** What a refused removal of a hosting run's directory says. */
export const SHARED_HOST_REFUSAL = 'a worker runs in this task\'s worktree — stop it or clean it up first';

/** The run whose directory `run` works in: itself, or the host its workspace record names. A claim
 *  on that run's directory holds `run` off, and `run` being live holds that claim off. */
export function directoryRunId(run: RunRecord): string {
  return run.delegation?.role === 'worker' && !ownsDirectory(run.delegation.workspace) ? run.delegation.workspace.hostRunId : run.id;
}

/** The directory a run works in, from its record: the host path a shared worker's workspace
 *  records, else the worktree the engine recorded for the run (`worktreePath`), else the repository
 *  root. Never the working directory of a live session. */
export function recordedDirectory(run: RunRecord | undefined, repoRoot: string): string {
  return run?.delegation?.role === 'worker' && !ownsDirectory(run.delegation.workspace) ? run.delegation.workspace.path : run?.worktreePath ?? repoRoot;
}

/**
 * Whether a live worker works in `run`'s directory: one whose workspace record names `run` as its
 * host (`hostRunId`) and that is queued, running, waiting or mid-destroy. Every path that removes
 * or reclaims a run's directory asks this first. `workersOf` lists the workers of a family's root;
 * the host's family is its own, or its parent's when the host is a worker.
 */
export function hostsLiveSharedWorker(run: RunRecord, workersOf: (rootId: string) => readonly RunRecord[]): boolean {
  // Only a member of a worker family can host: a task that never had a session with workers has none to list.
  if (run.delegation?.role !== 'root' && run.delegation?.role !== 'worker') return false;
  const rootId = run.delegation.role === 'worker' ? run.delegation.parentRunId : run.id;
  return workersOf(rootId).some(worker => worker.delegation?.role === 'worker' && !ownsDirectory(worker.delegation.workspace) &&
    directoryRunId(worker) === run.id && isLiveRecord(worker));
}
