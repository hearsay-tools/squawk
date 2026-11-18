import type { RunRecord, RunStore } from './store.ts';
import { familyRecordIdOf, inspectableReceipts, supervisorIdOf } from './task-rights.ts';

/**
 * The two sets a lifecycle walk can mean by "the workers of this run" (hearsay-tools/squawk#3819).
 * The family is every worker whose receipt one family record holds; the supervised set is the
 * workers one task started. For the task that holds the record the family is the larger set.
 */
type Reads = Pick<RunStore, 'listWorkersOf'>;
const LIVE = ['queued', 'running', 'waiting'];

/** Every worker record of the family `run` belongs to. */
export function familyWorkers(store: Reads, run: RunRecord | undefined): RunRecord[] {
  const family = familyRecordIdOf(run);
  return family === undefined ? [] : store.listWorkersOf(family);
}

/** The worker records `run` supervises: the ones it started. */
export function supervisedWorkers(store: Reads, run: RunRecord | undefined): RunRecord[] {
  return run ? familyWorkers(store, run).filter(worker => supervisorIdOf(worker) === run.id) : [];
}

/**
 * The workers a task's completion answers for: the ones it started, and for the task that holds
 * the family record every worker of the family. A receipt whose record is gone is still listed.
 */
export function completionWorkerIds(store: Reads, run: RunRecord, family: RunRecord | undefined): string[] {
  const records = family?.id === run.id ? familyWorkers(store, run) : supervisedWorkers(store, run);
  return [...new Set([...inspectableReceipts(run, family).map(receipt => receipt.workerId), ...records.map(worker => worker.id)])];
}

export function isLiveWorker(worker: RunRecord): boolean {
  return LIVE.includes(worker.status);
}
