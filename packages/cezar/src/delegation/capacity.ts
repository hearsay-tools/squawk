import type { WorkerCapacity } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';
import { grantsOf, hasSpawnRoom, receiptsOf, supervisedReceipts, type Lookup } from '../runs/task-rights.ts';

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

/** The outstanding workers that count against `supervisor`'s own limit: the ones it started,
 *  by the receipts of its family record. A receipt whose record is gone still counts. */
export function supervisedOutstanding(family: RunRecord, supervisor: RunRecord, getRun: Lookup): number {
  return supervisedReceipts(family, supervisor.id).filter(receipt => holdsSlot(receipt, getRun(receipt.workerId))).length;
}

/** What a refused creation says when the family has no free slot. */
export const OUTSTANDING_REFUSAL = 'Parent has 32 outstanding workers (accepted, live, or not verifiably destroyed). Collect results, then destroy finished workers to free capacity; incomplete cleanup holds its slot until a retry completes';

/** The refusal for a NEW creation, naming its recovery; undefined when a creation fits. */
export function capacityError(capacity: WorkerCapacity): string | undefined {
  if (capacity.created >= capacity.creationLimit) return 'Parent reached 1,024 worker creations; start a new task to delegate further';
  return capacity.outstanding >= capacity.limit ? OUTSTANDING_REFUSAL : undefined;
}

/** What a refused creation says when the caller holds no spawn grant. */
export const NO_SPAWN_GRANT = `This task cannot spawn Squawk workers.`;

/** What a refused creation says when the caller's own limit is full. */
export function ownLimitRefusal(outstanding: number, limit: number): string {
  return `You have ${outstanding} outstanding ${outstanding === 1 ? 'worker' : 'workers'} of the ${limit} you may have at a time (accepted, live, or not verifiably destroyed). Collect its result, then destroy a finished worker (worker destroy <worker-id>) before you start another`;
}

/**
 * Why `supervisor` may not start one more worker in `family`, or undefined. A creation needs room
 * in both: the family record (32 outstanding, 1,024 creations) and the supervisor's own limit.
 */
export function spawnCapacityRefusal(family: RunRecord, supervisor: RunRecord, getRun: Lookup): string | undefined {
  const grant = grantsOf(supervisor).spawn;
  if (!grant) return NO_SPAWN_GRANT;
  const outstanding = supervisedOutstanding(family, supervisor, getRun);
  return capacityError(workerCapacity(family, getRun)) ??
    (hasSpawnRoom(supervisor, outstanding) ? undefined : ownLimitRefusal(outstanding, grant.live));
}
