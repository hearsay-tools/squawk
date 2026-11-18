import type { ConversationState, DelegationState, WorkerOperation } from '@open-mercato/cezar-contract';
import { workerOperationSchema, type SpawnGrant, type WorkerWorkspace } from '@open-mercato/cezar-contract/delegation';
import type { RunRecord } from './store.ts';

/**
 * Who may do what to whom (hearsay-tools/squawk#3819). A relation is a fact read from two records;
 * a grant is data on the acting task's record. A spawn, an operation on a worker or a message is
 * allowed when the relation exists and the actor's grant holds it. Lifecycle state (a parent that
 * is not active, a pending Finish) is the caller's check; the per-task switches stay outside.
 */
type RootDelegation = Extract<DelegationState, { role: 'root' }>;
/** The run that holds a family's receipts and its conversation ledger. */
export type FamilyRecord = RunRecord & { delegation: RootDelegation };
export type Lookup = (id: string) => RunRecord | undefined;
/** `supervisor`: the other task supervises this one. `supervised`: this task supervises the other.
 *  `peer`: two root tasks of one project. */
export type TaskRelation = 'supervisor' | 'supervised' | 'peer';
export type TaskGrants = {
  /** What the task may spawn; undefined when it may spawn nothing. */
  readonly spawn: SpawnGrant | undefined;
  /** The operations the task may apply to workers it supervises. */
  readonly operate: readonly WorkerOperation[];
  /** The relations the task may use to send a message. */
  readonly message: readonly TaskRelation[];
};

const NO_GRANTS: TaskGrants = { spawn: undefined, operate: [], message: [] };
/** What a record of each role holds when it stores no grant of its own. */
export const DEFAULT_GRANTS: Readonly<Record<'root' | 'worker', TaskGrants>> = {
  root: { spawn: { kinds: ['owned-isolated', 'shared'], live: 32 }, operate: workerOperationSchema.options, message: ['supervised', 'peer'] },
  worker: { spawn: undefined, operate: [], message: ['supervisor', 'supervised'] },
};

/** The grants a task holds: its stored ones, else its role's defaults. A task with no record, or
 *  a quarantined one, holds none. */
export function grantsOf(run: RunRecord | undefined): TaskGrants {
  const record = run?.delegation;
  if (!record || record.role === 'invalid') return NO_GRANTS;
  const defaults = DEFAULT_GRANTS[record.role];
  return { spawn: record.spawnGrant ?? defaults.spawn, operate: record.permissions, message: defaults.message };
}

/** The spawn grant a worker of `parent` gets at its creation. */
export function childSpawnGrant(parent: RunRecord | undefined): SpawnGrant | undefined {
  return grantsOf(parent).spawn?.children;
}

export function isFamilyRecord(run: RunRecord | undefined): run is FamilyRecord {
  return run?.delegation?.role === 'root';
}

/** A root task: a family record, or a top-level run with no record yet, which has not opened a
 *  delegation session yet (spec 2026-10-27-task-communication-protocol § 2). */
export function isRootTask(run: RunRecord | undefined): run is RunRecord {
  return !!run && (run.delegation === undefined || isFamilyRecord(run));
}

/** The run that supervises this one; undefined for a task nobody supervises. */
export function supervisorIdOf(run: RunRecord | undefined): string | undefined {
  return run?.delegation?.role === 'worker' ? run.delegation.parentRunId : undefined;
}

/** The run that holds this task's family record: a root holds its own. */
export function familyRecordIdOf(run: RunRecord | undefined): string | undefined {
  if (isFamilyRecord(run)) return run.id;
  return run?.delegation?.role === 'worker' ? run.delegation.parentRunId : undefined;
}

export function familyRecordOf(run: RunRecord | undefined, getRun: Lookup): FamilyRecord | undefined {
  if (isFamilyRecord(run)) return run;
  const id = familyRecordIdOf(run);
  const record = id === undefined ? undefined : getRun(id);
  return isFamilyRecord(record) ? record : undefined;
}

/** The receipts a record holds; a run that is not a family record holds none. */
export function receiptsOf(run: RunRecord | undefined): RootDelegation['receipts'] {
  return isFamilyRecord(run) ? run.delegation.receipts : [];
}

/** The ledger a record holds, once its first message is written. */
export function conversationOf(run: RunRecord | undefined): ConversationState | undefined {
  return isFamilyRecord(run) ? run.delegation.conversation : undefined;
}

/** A family record whose history deletion is pending. */
export function historyDeleting(run: RunRecord | undefined): boolean {
  return isFamilyRecord(run) && !!run.delegation.historyDeletion;
}

/** A task whose human pressed Finish, which has not settled yet. */
export function finishing(run: RunRecord | undefined): boolean {
  return isFamilyRecord(run) && !!run.delegation.finishRequestedAt;
}

function supervises(supervisor: RunRecord, worker: RunRecord): boolean {
  return supervisorIdOf(worker) === supervisor.id && worker.delegation?.role === 'worker' &&
    worker.delegation.workspace?.ownerRunId === worker.id;
}

/** The relation of `from` to `to`, from the two records alone. */
export function relationOf(from: RunRecord | undefined, to: RunRecord | undefined): TaskRelation | undefined {
  if (!from || !to || from.id === to.id) return undefined;
  if (supervises(to, from)) return 'supervisor';
  if (supervises(from, to)) return 'supervised';
  return isRootTask(from) && isRootTask(to) ? 'peer' : undefined;
}

export function holdsOperation(actor: RunRecord | undefined, operation: WorkerOperation): boolean {
  return grantsOf(actor).operate.includes(operation);
}

/** `actor` supervises `target` and holds `operation`. */
export function mayOperate(actor: RunRecord | undefined, target: RunRecord | undefined, operation: WorkerOperation): boolean {
  return relationOf(actor, target) === 'supervised' && holdsOperation(actor, operation);
}

/** `actor` holds `spawn` and a spawn grant for `kind`; with no kind, for any kind. */
export function maySpawn(actor: RunRecord | undefined, kind?: WorkerWorkspace['kind']): boolean {
  const kinds = grantsOf(actor).spawn?.kinds ?? [];
  return holdsOperation(actor, 'spawn') && (kind === undefined ? kinds.length > 0 : kinds.includes(kind));
}

/** `actor`'s own limit: `outstanding` counts the workers it supervises that hold a slot. */
export function hasSpawnRoom(actor: RunRecord | undefined, outstanding: number): boolean {
  return outstanding < (grantsOf(actor).spawn?.live ?? 0);
}

/**
 * The relation `from` may use to message `to`, or undefined. The message grant of `from` holds the
 * relation, neither task's family record is deleting its history, and a supervised worker has a
 * live receipt on its own family record. `getRun` finds a family record that neither task is.
 */
export function messageRelation(from: RunRecord | undefined, to: RunRecord | undefined, getRun: Lookup): TaskRelation | undefined {
  const relation = relationOf(from, to);
  if (!relation || !grantsOf(from).message.includes(relation)) return undefined;
  if ([from, to].some(run => historyDeleting(familyRecordOf(run, getRun)))) return undefined;
  if (relation === 'peer') return relation;
  const worker = relation === 'supervised' ? to! : from!;
  return receiptsOf(familyRecordOf(worker, getRun)).some(receipt => receipt.workerId === worker.id && !receipt.deletion) ? relation : undefined;
}
