import type { RunRelationships } from '@open-mercato/cezar-contract/delegation';
import { workerCapacity } from '../delegation/capacity.ts';
import { workerDestroyView, workerObservation } from '../runs/delegation-state.ts';
import type { RunRecord } from '../runs/store.ts';
import type { RunFamilyReads, RunLookup, WorkerExecutions } from '../runs/ports.ts';
import { familyRecordOf, isFamilyRecord, supervisedReceipts, supervisorIdOf } from '../runs/task-rights.ts';

type Reads = RunLookup & Pick<RunFamilyReads, 'listOwnedWorkers'> & { readonly workerExecutions: Pick<WorkerExecutions, 'readWorkerExecution'> };

/**
 * What the cockpit shows around one run: a root's whole family, each worker naming the worker that
 * started it; a worker's own supervised workers, with its parent and its supervisor.
 * Off the family record's receipts, not a scan of the project index (#659): archived and off-page
 * workers still belong to the family, and the read costs O(workers) whatever the store holds, and
 * one record read for a run that has none. Human reads use the bound project, never agent
 * credentials or private evidence. Every worker is listed, bounded by the 1,024 creation ceiling
 * (#816); the titles name the runs the answer names (#864).
 */
export function runRelationships(store: Reads, run: RunRecord): RunRelationships {
  const getRun = (id: string) => store.getRun(id);
  const parent = run.delegation?.role === 'worker' ? getRun(run.delegation.parentRunId) : undefined;
  const supervisorId = run.delegation?.role === 'worker' ? run.delegation.supervisorRunId : undefined;
  const listed = isFamilyRecord(run) ? store.listOwnedWorkers(run.id)
    : supervisedReceipts(familyRecordOf(run, getRun), run.id).flatMap(receipt => {
      const worker = getRun(receipt.workerId);
      return worker && supervisorIdOf(worker) === run.id ? [worker] : [];
    });
  const workers = listed.flatMap(worker => {
    const owned = worker.delegation;
    if (owned?.role !== 'worker') return [];
    return [{ workerId: worker.id, parentRunId: owned.parentRunId,
      ...(owned.supervisorRunId === undefined ? {} : { supervisorRunId: owned.supervisorRunId }),
      status: worker.status, workspace: owned.workspace,
      settled: workerObservation(worker, store.workerExecutions.readWorkerExecution(worker.id)).settled,
      ...(worker.currentStepId === undefined ? {} : { currentStepId: worker.currentStepId }),
      ...(owned.destroy ? { destroy: workerDestroyView(worker) } : {}),
    }];
  });
  const supervisor = supervisorId === undefined ? undefined : getRun(supervisorId);
  const titles = [...(parent ? [parent] : []), ...(supervisor ? [supervisor] : []), ...listed].map(related => ({
    id: related.id, title: related.title,
    ...(related.titleSummary === undefined ? {} : { titleSummary: related.titleSummary }),
    ...(related.titleOrigin === undefined ? {} : { titleOrigin: related.titleOrigin }),
  }));
  return {
    ...(run.delegation?.role === 'worker' ? { parentRunId: run.delegation.parentRunId } : {}),
    ...(supervisorId === undefined ? {} : { supervisorRunId: supervisorId }), workers,
    ...(titles.length > 0 ? { titles } : {}),
    ...(isFamilyRecord(run) ? { capacity: workerCapacity(run, getRun) } : {}),
  };
}
