/** The one place lifecycle code reaches a worker's scope: spawn sites wrap their command through
 * `spawnScope`, Continue after a crash calls `kill`, destroy calls `stop`. The host's backend is
 * picked once per controller and never changes inside it; a backend error fails the operation
 * that met it, never falls back to another mechanism (ADR 0032). */
import { logPrefix } from '../home/display.ts';
import type { RecordedProcess } from '../core/process-stat.ts';
import type { RunRecord } from '@open-mercato/cezar-contract';
import type { WorkerProcessRecord } from '../delegation/process-liveness.ts';
import { cgroupCommand, cgroupPopulated, ensureCgroup, killCgroup, probeCgroups, removeCgroup, workerCgroupPath } from './cgroup.ts';
import { groupEntry, groupsStillStopping, killGroups, liveGroups } from './groups.ts';
import { GUARANTEE, SCOPE_CGROUP_CAP, SCOPE_GROUP_CAP, type ScopeBackend, type ScopeGuarantee, type ScopeRecord, type SpawnScope } from './scope.ts';

export type HostScope = { backend: 'cgroup'; base: string } | { backend: 'groups'; reason: string };

let host: HostScope | undefined;

/** This controller's backend: `cgroup` where a real probe proves delegation, else `groups`. */
export function hostScope(): HostScope {
  if (host) return host;
  const probe = process.platform === 'linux' ? probeCgroups() : { reason: `${process.platform} has no cgroups` };
  host = 'base' in probe ? { backend: 'cgroup', base: probe.base } : { backend: 'groups', reason: probe.reason };
  console.info(`${logPrefix()} worker scope: ${host.backend === 'cgroup' ? `cgroup (contained) under ${host.base}`
    : `process groups (scoped: a detached descendant can outlive destroy) — ${host.reason}`}`);
  return host;
}

/** Tests pin the backend; `undefined` re-probes on next use. */
export function setHostScope(value: HostScope | undefined): void { host = value; }

/** The store operations a scope needs. */
export interface ScopeStore {
  readWorkerScope(id: string): ScopeRecord | 'absent' | 'unknown';
  writeWorkerScope(id: string, record: ScopeRecord): void;
  getRun(id: string): RunRecord | undefined;
  readWorkerExecution(id: string): { generation: string } | undefined;
  readWorkerProcesses(id: string, generation: string): WorkerProcessRecord | 'absent' | 'unknown';
}

export class WorkerScopeUnreadable extends Error {
  constructor() { super("the worker's scope record is unreadable; its processes cannot be found"); }
}

const capacityError = (workerId: string) => new Error(`worker ${workerId} already owns ${SCOPE_GROUP_CAP} live process groups`);

export type ScopeStop = { stopped: true } | { stopped: false; error: string };
const STOP_POLL_MS = 10;

export class WorkerScopes {
  constructor(private readonly store: ScopeStore, private readonly hostOf: () => HostScope = hostScope) {}

  describe(): { backend: ScopeBackend; guarantee: ScopeGuarantee } {
    const { backend } = this.hostOf();
    return { backend, guarantee: GUARANTEE[backend] };
  }

  /** The scope every process of `workerId` starts in. The record names a cgroup before the cgroup
   * exists and before anything enters it, so a crash at any point leaves nothing unrecorded. */
  spawnScope(workerId: string): SpawnScope {
    return {
      command: (file, args) => {
        const run = this.store.getRun(workerId);
        if (run?.delegation?.role === 'worker' && run.delegation.destroy) throw new Error('Worker destruction has begun; nothing new starts in its scope');
        const host = this.hostOf();
        // Refused before anything runs: a full group record never has to end a started process.
        if (host.backend === 'groups' && liveGroups(this.read(workerId).groups).length >= SCOPE_GROUP_CAP) throw capacityError(workerId);
        if (host.backend !== 'cgroup') return [file, [...args]];
        const path = workerCgroupPath(host.base, workerId);
        this.update(workerId, record => {
          if (record.cgroups.includes(path)) return record;
          if (record.cgroups.length >= SCOPE_CGROUP_CAP) throw new Error(`worker ${workerId} already spans ${SCOPE_CGROUP_CAP} cgroups`);
          return { ...record, cgroups: [...record.cgroups, path] };
        });
        return cgroupCommand(ensureCgroup(host.base, workerId), file, args);
      },
      started: pid => {
        if (this.hostOf().backend !== 'groups' || process.platform === 'win32') return;
        this.update(workerId, record => {
          const live = liveGroups(record.groups);
          // Never forget a live group to make room: refuse the start instead (the caller ends it).
          if (live.length >= SCOPE_GROUP_CAP) throw capacityError(workerId);
          return { ...record, groups: [...live, groupEntry(pid)] };
        });
      },
    };
  }

  /** Whether no process the worker owns still runs: its cgroups are unpopulated and none of its
   * recorded groups has a member. An unreadable record is not empty. */
  empty(workerId: string): boolean {
    let record: ScopeRecord;
    try { record = this.read(workerId); } catch { return false; }
    return !record.cgroups.some(path => cgroupPopulated(path)) && !liveGroups(this.groups(workerId, record)).length;
  }

  /** After `kill`: whether nothing the worker owned still runs. A cgroup drops a task when it exits,
   * zombie or not; a group counts while its recorded leader runs (see `groupsStillStopping`). */
  stopped(workerId: string): boolean {
    let record: ScopeRecord;
    try { record = this.read(workerId); } catch { return false; }
    return !record.cgroups.some(path => cgroupPopulated(path)) && !groupsStillStopping(this.groups(workerId, record)).length;
  }

  /** SIGKILL everything the worker owns, now, without waiting. */
  kill(workerId: string): void {
    const record = this.read(workerId);
    for (const path of record.cgroups) killCgroup(path);
    killGroups(this.groups(workerId, record));
  }

  /** End everything the worker owns and remove its cgroups, within `timeoutMs`. What could not be
   * stopped stays recorded, so a retry starts from it. */
  async stop(workerId: string, timeoutMs: number): Promise<ScopeStop> {
    let record: ScopeRecord;
    try { record = this.read(workerId); } catch (error) { return { stopped: false, error: (error as Error).message }; }
    const deadline = Date.now() + timeoutMs;
    killGroups(this.groups(workerId, record));
    const cgroups: string[] = [];
    for (const path of record.cgroups) if (!await removeCgroup(path, deadline)) cgroups.push(path);
    let groups = groupsStillStopping(this.groups(workerId, record));
    while (groups.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, STOP_POLL_MS));
      groups = groupsStillStopping(groups);
    }
    this.store.writeWorkerScope(workerId, { workerId, cgroups, groups });
    if (!cgroups.length && !groups.length) return { stopped: true };
    return { stopped: false, error: `worker processes did not stop within ${Math.round(timeoutMs / 1000)}s: ${
      [...cgroups.map(path => `cgroup ${path}`), ...groups.map(group => `process group ${group.pgid}`)].join(', ')}` };
  }

  private read(workerId: string): ScopeRecord {
    const record = this.store.readWorkerScope(workerId);
    if (record === 'unknown') throw new WorkerScopeUnreadable();
    return record === 'absent' ? { workerId, cgroups: [], groups: [] } : record;
  }

  /** The record's groups and the current execution's recorded processes, without duplicates. A
   * worker created before scopes has its session groups only in its execution record. */
  private groups(workerId: string, record: ScopeRecord): RecordedProcess[] {
    const generation = this.store.readWorkerExecution(workerId)?.generation;
    const execution = generation ? this.store.readWorkerProcesses(workerId, generation) : 'absent';
    const seen = new Set(record.groups.map(group => `${group.pid}:${group.startToken}`));
    const recorded = typeof execution === 'string' ? [] : execution.processes;
    return [...record.groups, ...recorded.filter(entry => !seen.has(`${entry.pid}:${entry.startToken}`))];
  }

  private update(workerId: string, change: (record: ScopeRecord) => ScopeRecord): void {
    const record = this.read(workerId);
    const next = change(record);
    if (next !== record) this.store.writeWorkerScope(workerId, next);
  }
}
