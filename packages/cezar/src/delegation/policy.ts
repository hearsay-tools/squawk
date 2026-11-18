import { delegationStateSchema } from '@open-mercato/cezar-contract/delegation';
import type { DelegationErrorResponse, WorkerOperation, WorkerCollectedResult, ModelChoices } from '@open-mercato/cezar-contract';
import type { WorkerWorkspace } from '@open-mercato/cezar-contract/delegation';
import { messagingAllowed, workersAllowed } from '@open-mercato/cezar-contract/task-options';
import type { RunRecord } from '../runs/store.ts';
import { familyRecordOf, finishing, hasSpawnRoom, historyDeleting, holdsOperation, mayOperate, maySpawn, receiptsOf, type Lookup } from '../runs/task-rights.ts';
import { isAuthenticatedCaller, type Caller } from './credentials.ts';
import { capacityError, OUTSTANDING_REFUSAL, supervisedOutstanding, workerCapacity } from './capacity.ts';

export type { WorkerOperation } from '@open-mercato/cezar-contract';

export class DelegationPolicyError extends Error {
  constructor(readonly code: DelegationErrorResponse['code'], message: string, readonly modelChoices?: ModelChoices) {
    super(message);
    this.name = 'DelegationPolicyError';
  }
}

/** Task access (hearsay-tools/cezarion#2784): the human's per-task switches, read at every call. */
export const WORKERS_OFF = `Squawk workers are off for this task. A human can turn them on in the task menu.`;
export const MESSAGING_OFF = 'Task messaging is off for this task. A human can turn it on in the task menu.';
/** The messaging-off refusal. The CLI still answers `incompatible_state` with MESSAGING_OFF;
 *  `cezar_wait` tells it apart by this class, never by its text. */
export class MessagingOffError extends DelegationPolicyError {
  constructor() { super('incompatible_state', MESSAGING_OFF); }
}
export function requireWorkersAllowed(parent: RunRecord): void {
  if (!workersAllowed(parent)) throw new DelegationPolicyError('incompatible_state', WORKERS_OFF);
}
export function requireMessagingAllowed(run: RunRecord): void {
  if (!messagingAllowed(run)) throw new MessagingOffError();
}

function denyScope(): never {
  // Deliberately identical for absent, malformed, wrong-project and unrelated records.
  throw new DelegationPolicyError('denied_scope', 'Worker scope denied');
}

/** The authenticated caller is `actor`, its record is well-formed and its operate grant holds `operation`. */
function requireOperation(caller: Caller, actor: RunRecord | undefined, projectId: string, operation: WorkerOperation): asserts actor is RunRecord {
  if (!isAuthenticatedCaller(caller) || caller.projectId !== projectId || !actor || caller.runId !== actor.id) denyScope();
  if (!delegationStateSchema.safeParse(actor.delegation).success || !holdsOperation(actor, operation)) denyScope();
}

function requireActiveParent(parent: RunRecord): void {
  if (historyDeleting(parent)) {
    throw new DelegationPolicyError('incompatible_state', 'Parent history deletion is pending; retry deletion');
  }
  if (parent.status !== 'running' && parent.status !== 'waiting') {
    throw new DelegationPolicyError('incompatible_state', 'Parent session is not active');
  }
}

/** projectId is the service's trusted store context; RunRecord itself has no project field. */
export function authorizeWorker(caller: Caller, target: RunRecord | undefined, operation: WorkerOperation, parent: RunRecord | undefined, projectId: string): void {
  requireOperation(caller, parent, projectId, operation);
  const parsed = delegationStateSchema.safeParse(target?.delegation);
  if (operation === 'spawn' || !target || !parsed.success || !mayOperate(parent, target, operation)) denyScope();
  requireActiveParent(parent);
  if (finishing(parent) && (operation === 'steer' || operation === 'wait')) {
    throw new DelegationPolicyError('incompatible_state', 'Parent finish is pending');
  }
  const destroy = parsed.data.role === 'worker' ? parsed.data.destroy : undefined;
  if (operation === 'steer' && (destroy || !['queued', 'running', 'waiting'].includes(target.status))) {
    const instruction = !destroy && !target.stopping && ['review', 'done', 'failed'].includes(target.status)
      ? ` To resume it with a new instruction, run worker resume ${target.id} "<instruction>" --id <new-message-UUID>; use a new message ID.`
      : '';
    throw new DelegationPolicyError('incompatible_state', `Worker no longer accepts steering.${instruction}`);
  }
  // Reads, wait and idempotent stop/destroy remain scoped but are allowed through destruction.
  // This grants no permission to relaunch or delete resources without the manager/Git barriers.
}

/** Listing is an inspection of the authenticated parent's durable receipts. */
export function authorizeWorkerList(caller: Caller, parent: RunRecord | undefined, projectId: string): asserts parent is RunRecord {
  requireOperation(caller, parent, projectId, 'inspect');
  requireActiveParent(parent);
}

/** Check before receipt lookup: replay skips the creation cap, never authority or lifecycle. */
export function authorizeSpawnReplay(caller: Caller, parent: RunRecord | undefined, projectId: string): asserts parent is RunRecord {
  requireOperation(caller, parent, projectId, 'spawn');
  if (!maySpawn(parent)) denyScope();
  requireActiveParent(parent);
  if (finishing(parent)) {
    throw new DelegationPolicyError('incompatible_state', 'Parent finish is pending');
  }
}

/** Authorizes a NEW creation of a `kind` worker against the caller's spawn grant, the family's
 * reclaimable capacity and its creation ceiling (#816).
 * The service resolves existing idempotency receipts before these limits. */
export function authorizeSpawn(caller: Caller, parent: RunRecord | undefined, projectId: string, getRun: Lookup, kind: WorkerWorkspace['kind']): void {
  authorizeSpawnReplay(caller, parent, projectId);
  const family = familyRecordOf(parent, getRun);
  if (!family || !maySpawn(parent, kind)) denyScope();
  // Read again at the serial queue head and just before acceptance: a switch turned off while a
  // spawn waited refuses it. A replayed request ID skips this, as accepted work finishes.
  requireWorkersAllowed(parent);
  const refusal = capacityError(workerCapacity(family, getRun)) ??
    (hasSpawnRoom(parent, supervisedOutstanding(family, parent, getRun)) ? undefined : OUTSTANDING_REFUSAL);
  if (refusal) throw new DelegationPolicyError('capacity_limit', refusal);
}

/** Cancellation and settled receipt reads share ownership and the wait grant, not registration's active-session requirement. */
export function authorizeCancelWait(caller: Caller, parent: RunRecord | undefined, projectId: string): void {
  requireOperation(caller, parent, projectId, 'wait');
  if (historyDeleting(parent)) {
    throw new DelegationPolicyError('incompatible_state', 'Parent history deletion is pending; retry deletion');
  }
}

/** Retained results require both durable ownership and an actual parent-owned payload. */
export function authorizeRetainedResult(caller: Caller, parent: RunRecord | undefined, projectId: string, workerId: string, result: WorkerCollectedResult | undefined): void {
  requireOperation(caller, parent, projectId, 'inspect');
  if (!receiptsOf(parent).some(receipt => receipt.workerId === workerId) ||
    !result || result.parentRunId !== parent.id || result.workerId !== workerId) denyScope();
  requireActiveParent(parent);
}
