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
  /** The operations the task may apply to every worker whose receipt its own family record holds,
   *  whoever supervises that worker. */
  readonly operateFamily: readonly WorkerOperation[];
  /** The relations the task may use to send a message. */
  readonly message: readonly TaskRelation[];
};

const NO_GRANTS: TaskGrants = { spawn: undefined, operate: [], operateFamily: [], message: [] };
/** What Squawk writes on a new record of each role, and what a record holds for a grant it does
 *  not store. A record always stores `operate` (its `permissions`); a worker's `spawn` is the one
 *  its supervisor's grant gives it (`childSpawnGrant`), never this default. */
export const DEFAULT_GRANTS: Readonly<Record<'root' | 'worker', TaskGrants>> = {
  root: {
    spawn: { kinds: ['owned-isolated', 'shared'], live: 32, children: { kinds: ['shared'], live: 1 } },
    operate: workerOperationSchema.options, operateFamily: ['inspect', 'wait', 'stop', 'destroy'], message: ['supervised', 'peer'],
  },
  worker: { spawn: undefined, operate: workerOperationSchema.options, operateFamily: [], message: ['supervisor', 'supervised'] },
};

/** The grants a task holds: its stored ones, else its role's defaults. A task with no record, or
 *  a quarantined one, holds none. */
export function grantsOf(run: RunRecord | undefined): TaskGrants {
  const record = run?.delegation;
  if (!record || record.role === 'invalid') return NO_GRANTS;
  const defaults = DEFAULT_GRANTS[record.role];
  return { spawn: record.spawnGrant ?? defaults.spawn, operate: record.permissions, operateFamily: defaults.operateFamily, message: defaults.message };
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

/** The run that supervises this one: the task that started it. Undefined for a task nobody supervises. */
export function supervisorIdOf(run: RunRecord | undefined): string | undefined {
  return run?.delegation?.role === 'worker' ? run.delegation.supervisorRunId ?? run.delegation.parentRunId : undefined;
}

/** The task that holds the family record supervises this worker itself. A worker another worker
 *  started has no such line: its questions and notices go to the worker that started it. */
export function supervisedByFamilyRecord(run: RunRecord | undefined): boolean {
  return run?.delegation?.role === 'worker' && supervisorIdOf(run) === run.delegation.parentRunId;
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

type Receipt = RootDelegation['receipts'][number];
/** The task that started a receipt's worker: the one the receipt names, else the record's own task. */
export function receiptSupervisorId(family: RunRecord, receipt: Receipt): string {
  return receipt.supervisorRunId ?? family.id;
}

/** The receipts of the workers `supervisorId` started, in the family record that holds them. */
export function supervisedReceipts(family: RunRecord | undefined, supervisorId: string): Receipt[] {
  return family ? receiptsOf(family).filter(receipt => receiptSupervisorId(family, receipt) === supervisorId) : [];
}

function ownsItsRecord(worker: RunRecord): worker is RunRecord & { delegation: Extract<DelegationState, { role: 'worker' }> } {
  return worker.delegation?.role === 'worker' && worker.delegation.workspace?.ownerRunId === worker.id;
}

/** `supervisor` started `worker`, and both belong to one family. */
function supervises(supervisor: RunRecord, worker: RunRecord): boolean {
  if (!ownsItsRecord(worker) || supervisorIdOf(worker) !== supervisor.id) return false;
  const family = worker.delegation.parentRunId;
  return supervisor.id === family || familyRecordIdOf(supervisor) === family;
}

/** `actor` holds the family record that holds `worker`'s receipt. */
function holdsFamilyRecordOf(actor: RunRecord, worker: RunRecord): boolean {
  return isFamilyRecord(actor) && ownsItsRecord(worker) && worker.delegation.parentRunId === actor.id;
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

/** `actor` supervises `target` and holds `operation`, or holds `target`'s family record and holds
 *  `operation` for every worker of that record. */
export function mayOperate(actor: RunRecord | undefined, target: RunRecord | undefined, operation: WorkerOperation): boolean {
  if (!actor || !target || actor.id === target.id) return false;
  const grants = grantsOf(actor);
  return (grants.operate.includes(operation) && supervises(actor, target)) ||
    (grants.operateFamily.includes(operation) && holdsFamilyRecordOf(actor, target));
}

/** The receipts of the workers `actor` may inspect in `family`: the ones it started, and every one
 *  when it holds the record and inspects every worker of it. */
export function inspectableReceipts(actor: RunRecord, family: RunRecord | undefined): Receipt[] {
  if (!family) return [];
  const whole = family.id === actor.id && grantsOf(actor).operateFamily.includes('inspect');
  return receiptsOf(family).filter(receipt => whole || receiptSupervisorId(family, receipt) === actor.id);
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

/** The first kind `actor`'s spawn grant allows: what a spawn that names no kind plans. */
export function defaultSpawnKind(actor: RunRecord | undefined): WorkerWorkspace['kind'] | undefined {
  return grantsOf(actor).spawn?.kinds[0];
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
  const [supervisor, worker] = relation === 'supervised' ? [from!, to!] : [to!, from!];
  return supervisedReceipts(familyRecordOf(worker, getRun), supervisor.id).some(receipt => receipt.workerId === worker.id && !receipt.deletion) ? relation : undefined;
}
