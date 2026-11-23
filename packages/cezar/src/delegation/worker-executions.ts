import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { DelegationState } from '@open-mercato/cezar-contract';
import { startToken, type RecordedProcess, type WorkerProcessRecord } from '../core/process-stat.ts';
import { agentTmpDirMayExist, agentTmpDirOwnershipProven } from '../runs/agent-tmpdir.ts';
import { snapshotRun } from '../runs/lifecycle.ts';
import type { WorkerExecutionRecords, WorkerExecutions } from '../runs/ports.ts';
import { deletionRefusal } from '../runs/removal-slots.ts';
import type { RunRecord } from '../runs/store.ts';
import { admissibleExecution, holderRefusal, SPAWN_NEXT, WorkerAdmissionRefusal, workerExecutionSchema, type WorkerExecution } from '../runs/worker-execution.ts';
import type { WorkerExecutionsFactory, WorkerExecutionsState } from '../runs/worker-executions-registry.ts';
import { scopeRecordSchema, type ScopeRecord, type SpawnScope } from '../worker-scope/scope.ts';
import { WorkerScopes } from '../worker-scope/worker-scopes.ts';
import { updateWorkerIdentity, workerExecutionIdentitySchema, writeWorkerIdentity } from './execution-identity.ts';
import { readPrivateRecord, writePrivateRecord } from './private-record-file.ts';
import { workerDeletionProof } from './worker-deletion-proof.ts';
import { recordedHolders, workerResourceAuthorized } from './worker-resource-holders.ts';

const WORKER_PROCESS_CAP = 32;
const recordedProcessSchema = z.object({ pid: z.number().int().positive(), startToken: z.string().min(1).max(128).optional(),
  pgid: z.number().int().positive().optional() }).strict();
const workerProcessRecordSchema = z.object({ generation: z.string().uuid(), controller: recordedProcessSchema,
  processes: z.array(recordedProcessSchema).max(WORKER_PROCESS_CAP) }).strict();

/**
 * A worker's private execution, process, identity and scope records beside its run
 * (`runs/<id>.execution.json`, `.processes.json`, `.identity.json`, `.scope.json`), and the checks
 * that read them before a worker's resources are reused, reclaimed or deleted
 * (hearsay-tools/squawk#4039). The store builds one per store through the factory that
 * `registerBuiltInRunSlots()` registers (`runs/worker-executions-registry.ts`) and exposes it as
 * `store.workerExecutions`.
 */
export class WorkerExecutionsTopic implements WorkerExecutions, WorkerExecutionRecords {
  /** Every worker's process scope (ADR 0032): spawn sites, Continue and destroy reach it here. */
  readonly scopes: WorkerScopes = new WorkerScopes({
    readWorkerScope: (id) => this.readWorkerScope(id), writeWorkerScope: (id, record) => this.writeWorkerScope(id, record),
    getRun: (id) => this.state.getRun(id), readWorkerExecution: (id) => this.readWorkerExecution(id),
    readWorkerProcesses: (id, generation) => this.readWorkerProcesses(id, generation),
  });

  constructor(private readonly dataDir: string, private readonly state: WorkerExecutionsState) {}

  /** Private process-generation evidence; never part of run JSON or SSE. */
  identityPath(id: string, write = false): string {
    return this.executionPath(id, write).replace(/\.execution\.json$/, '.identity.json');
  }

  /** Checked against the worker identity schema, then written once (`writeWorkerIdentity`). */
  writeWorkerIdentity(id: string, identity: unknown): void {
    writeWorkerIdentity(this, id, workerExecutionIdentitySchema.parse(identity));
  }

  /** Atomically update an existing worker identity (same-runner model/effort override). */
  updateWorkerIdentity(id: string, identity: unknown): void {
    updateWorkerIdentity(this, id, workerExecutionIdentitySchema.parse(identity));
  }

  executionPath(id: string, write = false): string {
    z.string().uuid().parse(id);
    const dir = join(write ? this.state.writeDir(id) : this.state.sourceDataDir(id), 'runs');
    if (write) mkdirSync(dir, { recursive: true });
    if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== resolve(dir)) throw new Error('Unsafe execution directory');
    return join(dir, `${id}.execution.json`);
  }

  readWorkerExecution(id: string): WorkerExecution | undefined {
    try {
      const proof = readPrivateRecord(this.executionPath(id), 16384, value => workerExecutionSchema.parse(value));
      return typeof proof === 'string' ? undefined : proof;
    } catch { return undefined; }
  }

  writeWorkerExecution(id: string, proof: WorkerExecution, fresh = false): void {
    writePrivateRecord(this.executionPath(id, true), proof, { fresh });
  }

  /** Complete execution is not permission to reuse/delete persistent resources (#738).
   * Synchronous, fresh and generation/resource fenced; callers hold admission off across awaits. */
  workerResourcesSafe(id: string, generation: string, resourceId: string): boolean {
    // Reclaim and history deletion also need an empty scope; admission does not (ADR 0032).
    return this.workerResourceHolders(id, generation, resourceId) === 'safe' && this.scopes.empty(id);
  }

  /** `workerResourcesSafe` with the refusal's live PIDs (empty when no PID explains it). */
  workerResourceHolders(id: string, generation: string, resourceId: string,
    opts: { admittingQueued?: boolean } = {}): 'safe' | number[] {
    if (deletionRefusal(id, 'worktree', this.dataDir)) return [];
    const run = this.state.peek(id);
    const proof = this.readWorkerExecution(id);
    if (!workerResourceAuthorized(run, proof, id, generation, resourceId, opts.admittingQueued)) return [];
    const record = this.readWorkerProcesses(id, generation);
    if (record === 'unknown' || !agentTmpDirOwnershipProven(this.dataDir, id)) return [];
    // Only the generation's recorded processes count; an outside process blocks nothing (ADR 0032).
    return recordedHolders(record);
  }

  /** Upgrade a legacy completed checkpoint while terminal task ownership is still known.
   * No holder scan here: settlement and scheduling must never wait on cleanup proof. */
  retainWorkerScratchCleanup(id: string): void {
    const run = this.state.peek(id), proof = this.readWorkerExecution(id);
    if (run?.delegation?.role !== 'worker' || ['queued', 'running', 'waiting'].includes(run.status) || proof?.phase !== 'complete') return;
    const { resourceId, path } = run.delegation.workspace;
    if (proof.scratchCleanup?.resourceId === resourceId && proof.scratchCleanup.path === path) return;
    this.writeWorkerExecution(id, { ...proof, scratchCleanup: { resourceId, path } });
  }

  /** Cleanup can outlive its index row, but never its generation or terminal task intent. */
  workerScratchResourcesSafe(id: string, generation: string, resourceId: string): boolean {
    if (deletionRefusal(id, 'worktree', this.dataDir)) return false;
    const run = this.state.peek(id), proof = this.readWorkerExecution(id);
    if (proof?.phase !== 'complete' || proof.generation !== generation || proof.scratchCleanup?.resourceId !== resourceId ||
      (run && ['queued', 'running', 'waiting'].includes(run.status))) return false;
    // A process still in the worker's scope may use its scratch; one outside it is not the worker's.
    if (run?.delegation?.role === 'worker') return run.delegation.workspace.path === proof.scratchCleanup.path &&
      this.workerResourceHolders(id, generation, resourceId) === 'safe' && this.scopes.empty(id);
    // A valid different role contradicts the retained intent. Quarantined/missing metadata
    // supplies no new authority; only the private terminal checkpoint authorizes scratch.
    if (run && run.delegation?.role !== 'invalid') return false;
    const record = this.readWorkerProcesses(id, generation);
    if (record === 'unknown' || !agentTmpDirOwnershipProven(this.dataDir, id)) return false;
    return recordedHolders(record) === 'safe' && this.scopes.empty(id);
  }

  commitWorkerExecutionStart(id: string): string {
    const run = this.state.peek(id);
    if (run?.delegation?.role !== 'worker' || run.delegation.destroy) throw new WorkerAdmissionRefusal('the worker is being destroyed', SPAWN_NEXT);
    const prior = admissibleExecution(this.readWorkerExecution(id));
    const holders = this.workerResourceHolders(id, prior.generation, run.delegation.workspace.resourceId, { admittingQueued: true });
    if (holders !== 'safe') throw holderRefusal(holders, this.readWorkerProcesses(id, prior.generation));
    const generation = randomUUID();
    // #469: the controller is durable before `starting`, so a crash leaves a provable generation.
    this.writeWorkerProcesses(id, { generation, controller: { pid: process.pid, ...startToken(process.pid) }, processes: [] });
    this.writeWorkerExecution(id, { generation, phase: 'starting' });
    return generation;
  }

  /** Private process record (#469): which processes a generation spawned, never part of run JSON or SSE. */
  processesPath(id: string, write = false): string {
    return this.executionPath(id, write).replace(/\.execution\.json$/, '.processes.json');
  }

  /** Tri-state: only ENOENT is `absent` (legacy, scan-only). A present record that is unreadable,
   * wrongly permissioned, malformed or of another generation is `unknown`: never finalized or reaped. */
  readWorkerProcesses(id: string, generation: string): WorkerProcessRecord | 'absent' | 'unknown' {
    const record = readPrivateRecord(() => this.processesPath(id), 8192, value => workerProcessRecordSchema.parse(value));
    return typeof record === 'string' || record.generation === generation ? record : 'unknown';
  }

  private writeWorkerProcesses(id: string, record: WorkerProcessRecord): void {
    writePrivateRecord(this.processesPath(id, true), workerProcessRecordSchema.parse(record));
  }

  /** Private scope record: the cgroups and process groups the worker owns (ADR 0032). */
  scopePath(id: string, write = false): string {
    return this.executionPath(id, write).replace(/\.execution\.json$/, '.scope.json');
  }

  /** Tri-state like the process record: only ENOENT is `absent`. */
  readWorkerScope(id: string): ScopeRecord | 'absent' | 'unknown' {
    const record = readPrivateRecord(() => this.scopePath(id), 65_536, value => scopeRecordSchema.parse(value));
    return typeof record === 'string' || record.workerId === id ? record : 'unknown';
  }

  /** Durable before the caller acts on it. */
  writeWorkerScope(id: string, record: ScopeRecord): void {
    writePrivateRecord(this.scopePath(id, true), scopeRecordSchema.parse(record));
  }

  /** The scope a run's processes start in: a worker's own, none for any other run (ADR 0032). */
  spawnScope(id: string): SpawnScope | undefined {
    return this.state.peek(id)?.delegation?.role === 'worker' ? this.scopes.spawnScope(id) : undefined;
  }

  /** Bound to the current generation. Past the cap the record never drops an entry: the
   * working-directory scan is the remaining evidence. */
  appendWorkerProcess(id: string, generation: string, pid: number, pgid?: number): boolean {
    const record = this.readWorkerProcesses(id, generation);
    if (typeof record === 'string' || this.readWorkerExecution(id)?.generation !== generation) return false;
    const entry: RecordedProcess = { pid, ...startToken(pid), ...(pgid === undefined ? {} : { pgid }) };
    if (record.processes.some(known => known.pid === entry.pid && known.startToken === entry.startToken)) return true;
    if (record.processes.length >= WORKER_PROCESS_CAP) return false;
    this.writeWorkerProcesses(id, { ...record, processes: [...record.processes, entry] });
    return true;
  }

  commitWorkerExecutionComplete(id: string, generation: string, opts: { interrupted?: boolean } = {}): boolean {
    const proof = this.readWorkerExecution(id);
    if (!proof || proof.generation !== generation) return false;
    if (proof.phase === 'queued' && this.state.peek(id)?.status !== 'cancelled') return false;
    try {
      const run = this.state.peek(id);
      if (run?.delegation?.role !== 'worker') return false;
      this.state.commitIndex(new Map([[id, run]]));
      if (this.readWorkerExecution(id)?.generation !== generation) return false;
      this.writeWorkerExecution(id, { generation, phase: 'complete',
        // Nothing abandons an execution any more (hearsay-tools/cezarion#889); keep a checkpoint that already was.
        ...(proof.abandoned ? { abandoned: true as const } : {}),
        ...(proof.interrupted || (opts.interrupted && proof.phase === 'starting') ? { interrupted: true as const } : {}),
        ...(proof.phase === 'queued' || proof.neverMaterialized ? { neverMaterialized: true as const } : {}),
        ...(!['queued', 'running', 'waiting'].includes(run.status) ? { scratchCleanup: {
          resourceId: run.delegation.workspace.resourceId, path: run.delegation.workspace.path } } : {}) });
      // The earlier index event cannot attest exit: subscribers must observe the
      // durable private proof before a terminal worker can satisfy a lifecycle wait.
      const settled = this.state.peek(id)!;
      this.state.published.publish('run.updated', { run: settled, before: snapshotRun(settled) });
      return true;
    } catch { return false; }
  }

  /** A deleted child's receipt replaces the private proof only after the deletion checkpoint. */
  workerDeletionEvidence(id: string): boolean {
    const child = this.state.peek(id);
    if (child?.delegation?.role !== 'worker' || child.delegation.workspace.ownerRunId !== id ||
      child.delegation.destroy?.phase !== 'complete' || child.delegation.destroy.remaining.length ||
      !['review', 'done', 'failed', 'cancelled'].includes(child.status)) return false;
    return this.workerDeletionResult(id, child as RunRecord & { delegation: Extract<DelegationState, { role: 'worker' }> });
  }

  private workerDeletionResult(id: string, child: RunRecord & { delegation: Extract<DelegationState, { role: 'worker' }> }): boolean {
    const parent = this.state.peek(child.delegation.parentRunId);
    if (parent?.delegation?.role !== 'root' || parent.delegation.historyDeletion) return false;
    const receipt = parent.delegation.receipts.find(entry => entry.workerId === id);
    const result = this.state.workerResults.readWorkerResult(parent.id, id);
    if (!receipt || !result?.settled || result.cleanup !== 'complete' || result.status !== child.status ||
      result.revision !== (child.delegation.executionRevision ?? 0)) return false;
    const { state: _state, ...workspace } = result.workspace;
    if (JSON.stringify(workspace) !== JSON.stringify(child.delegation.workspace)) return false;
    return workerDeletionProof(receipt.deletion, result.revision, workspace.resourceId, {
      readProof: () => this.readWorkerExecution(id), resourcesSafe: generation => this.workerResourcesSafe(id, generation, workspace.resourceId),
      scratchMayExist: () => agentTmpDirMayExist(this.dataDir, id), executionExists: () => existsSync(this.executionPath(id)),
    });
  }
}

/** The factory `registerBuiltInRunSlots()` registers. */
export const createWorkerExecutions: WorkerExecutionsFactory = (dataDir, state) => new WorkerExecutionsTopic(dataDir, state);

/** The store's worker executions with their feature types: the scope backend and its stop. */
export function workerExecutionsOf(store: { readonly workerExecutions: WorkerExecutions }): WorkerExecutionsTopic {
  const topic = store.workerExecutions;
  if (!(topic instanceof WorkerExecutionsTopic)) throw new Error('This store holds no built-in worker executions.');
  return topic;
}
