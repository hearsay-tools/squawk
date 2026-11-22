/**
 * Create an owned worker run and its parent receipt. `RunStore.createOwnedRun` is a thin call
 * into `createStoreOwnedRun`; parent, capacity, ownership and resource checks stay here.
 */
import { randomUUID } from 'node:crypto';
import type { DelegationState, RunRecord } from '@open-mercato/cezar-contract';
import { delegationStateSchema, ownsDirectory, workerCreationReceiptSchema } from '@open-mercato/cezar-contract/delegation';
import { workerExecutionIdentitySchema, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import { receiptSupervisorId, supervisedReceipts, supervisorIdOf, type Lookup } from './task-rights.ts';
import type { WorkerExecution } from './worker-execution.ts';

type RootDelegation = Extract<DelegationState, { role: 'root' }>;
type WorkerDelegation = Extract<DelegationState, { role: 'worker' }>;
type CreationIdentity = Pick<RootDelegation['receipts'][number], 'requestId' | 'requestHash'>;
type WorkerWorkspace = WorkerDelegation['workspace'];

/** Why a supervisor may not start one more worker in a family, or undefined: the caller passes the spawn capacity check. */
export type SpawnCapacityRefusal = (family: RunRecord, supervisor: RunRecord, getRun: Lookup) => string | undefined;

/** The store lookups owned-run creation needs; no import of `store.ts`. */
export interface OwnedRunCreateLookup {
  peek(id: string): RunRecord | undefined;
  hasRun(id: string): boolean;
  held: ReadonlyMap<string, RunRecord>;
  deleted: ReadonlySet<string>;
  db: { findResourceHolders(resource: { branch: string; worktreePath: string }): string[] } | null;
}

/** The store methods owned-run creation needs, including the typed `buildRun` input. */
export interface OwnedRunCreateState<TInput extends { worktree?: false | undefined }> extends OwnedRunCreateLookup {
  buildRun(input: TInput, id: string): RunRecord;
  writeWorkerIdentity(id: string, identity: WorkerExecutionIdentity): void;
  writeWorkerExecution(id: string, proof: WorkerExecution, fresh?: boolean): void;
  commitIndex(input: ReadonlyMap<string, RunRecord | null>): void;
}

/**
 * requestHash is supplied only by the trusted service: hash the ORIGINAL normalized request,
 * before resolving refs. A retry keeps the original worker and pinned SHA even if HEAD moved.
 * workspace.ownerRunId is the trusted service's preallocated worker UUID.
 */
export function createStoreOwnedRun<TInput extends { worktree?: false | undefined }>(
  state: OwnedRunCreateState<TInput>,
  input: TInput,
  parentId: string,
  requestId: string,
  worker: DelegationState,
  requestHash: string,
  spawnCapacityRefusal: SpawnCapacityRefusal,
  executionIdentity: WorkerExecutionIdentity,
): RunRecord {
  const { parent, authority } = resolveOwnedRunParent(state, parentId);
  // Validate retry identity independently of the newly proposed resource.
  const identity = workerCreationReceiptSchema.pick({ requestId: true, requestHash: true })
    .parse({ requestId, requestHash });
  const supervisorId = worker.role === 'worker' ? worker.supervisorRunId ?? parentId : parentId;
  // A request ID is one supervisor's: another supervisor's same ID names its own worker.
  const receipt = supervisedReceipts(parent, supervisorId).find((entry) => entry.requestId === identity.requestId);
  if (receipt) return existingOwnedRunReceipt(state, parentId, receipt, identity);
  const metadata = parseOwnedWorkerMetadata(worker, parentId, input.worktree);
  // The supervisor's liveness, its own limit and the family's limits (#816) are read here, in the
  // step that writes the receipt, so no path writes a receipt past any of them. The spawn policy
  // checks the grant's kinds in the same synchronous step, before this call.
  const supervisor = liveSupervisor(state, parent, supervisorId);
  const refusal = spawnCapacityRefusal(parent, supervisor, (id) => state.peek(id));
  if (refusal) throw new Error(refusal);
  assertWorkerResourceFree(state, metadata.workspace);
  return publishOwnedRun(state, parentId, parent, authority, identity, metadata, input, executionIdentity);
}

/** The task that starts the worker: the family's root, or a worker of this family that still runs,
 *  is not being destroyed and holds a live receipt. */
function liveSupervisor(state: OwnedRunCreateLookup, parent: RunRecord, supervisorId: string): RunRecord {
  if (supervisorId === parent.id) return parent;
  const supervisor = state.peek(supervisorId);
  const metadata = delegationStateSchema.safeParse(supervisor?.delegation);
  if (!supervisor || !metadata.success || metadata.data.role !== 'worker' || metadata.data.parentRunId !== parent.id ||
    metadata.data.workspace.ownerRunId !== supervisor.id || metadata.data.destroy || supervisor.stopping ||
    !['running', 'waiting'].includes(supervisor.status) ||
    !supervisedReceipts(parent, supervisorIdOf(supervisor)!).some((entry) => entry.workerId === supervisor.id && !entry.deletion)) {
    throw new Error('invalid delegation supervisor');
  }
  return supervisor;
}

function resolveOwnedRunParent(
  state: OwnedRunCreateLookup,
  parentId: string,
): { parent: RunRecord; authority: RootDelegation } {
  const parent = state.peek(parentId);
  const authority = delegationStateSchema.safeParse(parent?.delegation);
  if (!parent || !authority.success || authority.data.role !== 'root' || authority.data.historyDeletion) {
    throw new Error('invalid delegation parent');
  }
  return { parent, authority: authority.data };
}

function existingOwnedRunReceipt(
  state: OwnedRunCreateLookup,
  parentId: string,
  receipt: RootDelegation['receipts'][number],
  identity: CreationIdentity,
): RunRecord {
  if (receipt.requestHash !== identity.requestHash) throw new Error('request ID payload conflict');
  const existing = state.peek(receipt.workerId);
  const metadata = delegationStateSchema.safeParse(existing?.delegation);
  const parent = state.peek(parentId);
  if (!existing || !parent || !metadata.success || metadata.data.role !== 'worker' ||
    metadata.data.parentRunId !== parentId || metadata.data.workspace.ownerRunId !== existing.id ||
    supervisorIdOf(existing) !== receiptSupervisorId(parent, receipt) ||
    existing.id === parentId) throw new Error('invalid request receipt ownership');
  return existing;
}

function parseOwnedWorkerMetadata(
  worker: DelegationState,
  parentId: string,
  worktree: false | undefined,
): WorkerDelegation {
  const metadata = delegationStateSchema.parse(worker);
  if (metadata.role !== 'worker' || metadata.parentRunId !== parentId ||
    metadata.workspace.ownerRunId === parentId || metadata.supervisorRunId === metadata.workspace.ownerRunId ||
    metadata.supervisorRunId === parentId || worktree === false) {
    throw new Error('invalid worker ownership');
  }
  return metadata;
}

function assertWorkerResourceFree(
  state: OwnedRunCreateLookup,
  workspace: WorkerWorkspace,
): void {
  if (state.hasRun(workspace.ownerRunId)) throw new Error('worker run ID collision');
  assertHeldResourcesFree(state.held, workspace);
  assertStoredResourcesFree(state, workspace);
}

function assertHeldResourcesFree(held: ReadonlyMap<string, RunRecord>, workspace: WorkerWorkspace): void {
  for (const run of held.values()) {
    if (heldResourceCollides(run, workspace)) throw new Error('worker resource ownership collision');
  }
}

/** A resource id is unique among workers of every kind. A directory and a branch collide only
 *  between workspaces that own theirs: a worker in its host's directory claims neither. */
function heldResourceCollides(run: RunRecord, workspace: WorkerWorkspace): boolean {
  const held = run.delegation?.role === 'worker' ? run.delegation.workspace : undefined;
  if (held?.resourceId === workspace.resourceId) return true;
  if (!ownsDirectory(workspace)) return false;
  return Boolean((held && ownsDirectory(held) && (held.path === workspace.path || held.branch === workspace.branch)) ||
    run.worktreePath === workspace.path || run.branch === workspace.branch);
}

function assertStoredResourcesFree(
  state: OwnedRunCreateLookup,
  workspace: WorkerWorkspace,
): void {
  if (!ownsDirectory(workspace)) return;
  // Runs not in memory answer through the branch and worktree columns. A worker's planned
  // branch is its `branch` column; its path and resource id derive from its own run id, which
  // the id check above already proved unused.
  if ((state.db?.findResourceHolders({ branch: workspace.branch, worktreePath: workspace.path }) ?? [])
    .some((id) => !state.held.has(id) && !state.deleted.has(id))) throw new Error('worker resource ownership collision');
}

function publishOwnedRun<TInput extends { worktree?: false | undefined }>(
  state: OwnedRunCreateState<TInput>,
  parentId: string,
  parent: RunRecord,
  authority: RootDelegation,
  identity: CreationIdentity,
  metadata: WorkerDelegation,
  input: TInput,
  executionIdentity: WorkerExecutionIdentity,
): RunRecord {
  const workspace = metadata.workspace;
  const delegation = delegationStateSchema.parse({
    ...authority,
    receipts: [...authority.receipts, { ...identity, workerId: workspace.ownerRunId,
      ...(metadata.supervisorRunId === undefined ? {} : { supervisorRunId: metadata.supervisorRunId }) }],
  });
  const run = { ...state.buildRun(input, workspace.ownerRunId), delegation: metadata };
  // This transaction precedes materialization. Every launch must rotate this
  // generation to starting before touching the workspace or a session.
  state.writeWorkerIdentity(run.id, workerExecutionIdentitySchema.parse(executionIdentity));
  state.writeWorkerExecution(run.id, { generation: randomUUID(), phase: 'queued' }, true);
  // No pruning here: deleting run history cannot be part of a proposed index transaction.
  state.commitIndex(new Map([[parentId, { ...parent, delegation }], [run.id, run]]));
  return run;
}
