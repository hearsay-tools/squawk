/**
 * Holder proof for worker persistent paths (worktree and scratch). `RunStore.workerResourceHolders`
 * reads the row and checkpoints, then these helpers decide whether the generation is gone. Only the
 * generation's recorded processes count: ownership is set when Squawk starts a process, never read
 * from which files a process uses (ADR 0032).
 */
import type { RunRecord } from '@open-mercato/cezar-contract';
import { isCurrentProcess, recordedProcessLive, type WorkerProcessRecord } from '../delegation/process-liveness.ts';
import type { WorkerExecution } from './worker-execution.ts';

type WorkerOwnedRun = RunRecord & { delegation: Extract<RunRecord['delegation'], { role: 'worker' }> };

/** The row owns this generation's workspace and the checkpoint is complete, or queued when admitting. */
export function workerResourceAuthorized(
  run: RunRecord | undefined,
  proof: WorkerExecution | undefined,
  id: string,
  generation: string,
  resourceId: string,
  admittingQueued?: boolean,
): run is WorkerOwnedRun {
  return !(run?.delegation?.role !== 'worker' || run.delegation.workspace.ownerRunId !== id ||
    run.delegation.workspace.resourceId !== resourceId || proof?.generation !== generation ||
    (proof.phase !== 'complete' && !(admittingQueued && proof.phase === 'queued')));
}

/** The live recorded processes of a generation: another live controller, else live session
 * processes. `safe` when none is live, or the generation predates process records. */
export function recordedHolders(record: WorkerProcessRecord | 'absent'): 'safe' | number[] {
  if (record === 'absent') return 'safe';
  if (!isCurrentProcess(record.controller) && recordedProcessLive(record.controller)) return [record.controller.pid];
  const pids = record.processes.filter(recordedProcessLive).map(entry => entry.pid);
  return pids.length ? pids : 'safe';
}
