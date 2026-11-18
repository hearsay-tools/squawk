import type { WorkerCapacity } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { receiptsOf, supervisorIdOf, type Lookup } from '../runs/task-rights.ts';

/**
 * Fixed resource capacity and lifetime creation ceiling. Verified destroy reclaims capacity;
 * neither limit is a spending budget.
 */
export const WORKER_CAPACITY = 32;
export const WORKER_CREATION_LIMIT = 1_024;

/**
 * Derive capacity from durable receipts. Only verified complete destroy or completed history
 * deletion releases one; a missing record still consumes capacity.
 */
export function workerCapacity(family: RunRecord, getRun: Lookup): WorkerCapacity {
  const receipts = receiptsOf(family);
  const outstanding = receipts.filter(receipt => holdsSlot(receipt, getRun(receipt.workerId))).length;
  return { outstanding, limit: WORKER_CAPACITY, created: receipts.length, creationLimit: WORKER_CREATION_LIMIT };
}

type Receipt = ReturnType<typeof receiptsOf>[number];
function holdsSlot(receipt: Receipt, worker: RunRecord | undefined): boolean {
  if (receipt.deletion) return false;
  const owned = worker?.delegation;
  return !(owned?.role === 'worker' && owned.destroy?.phase === 'complete' && owned.destroy.remaining.length === 0);
}

/** The family's outstanding workers that count against `supervisor`'s own limit: the ones it
 *  supervises, and the ones whose record is gone, which name no supervisor. */
export function supervisedOutstanding(family: RunRecord, supervisor: RunRecord, getRun: Lookup): number {
  return receiptsOf(family).filter(receipt => {
    const worker = getRun(receipt.workerId);
    return holdsSlot(receipt, worker) && (!worker || supervisorIdOf(worker) === supervisor.id);
  }).length;
}

/** What a refused creation says when the family or its caller has no free slot. */
export const OUTSTANDING_REFUSAL = 'Parent has 32 outstanding workers (accepted, live, or not verifiably destroyed). Collect results, then destroy finished workers to free capacity; incomplete cleanup holds its slot until a retry completes';

/** The refusal for a NEW creation, naming its recovery; undefined when a creation fits. */
export function capacityError(capacity: WorkerCapacity): string | undefined {
  if (capacity.created >= capacity.creationLimit) return 'Parent reached 1,024 worker creations; start a new task to delegate further';
  return capacity.outstanding >= capacity.limit ? OUTSTANDING_REFUSAL : undefined;
}
