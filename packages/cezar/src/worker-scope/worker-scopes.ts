/** The one place lifecycle code reaches a worker's scope: spawn sites wrap their command through
 * `spawnScope`, Continue after a crash calls `kill`, destroy calls `stop`. The host's backend is
 * picked once per controller and never changes inside it; a backend error fails the operation
 * that met it, never falls back to another mechanism (ADR 0032). */
import type { RecordedProcess } from '../core/process-stat.ts';
import type { RunRecord } from '@open-mercato/cezar-contract';
import type { WorkerProcessRecord } from '../core/process-stat.ts';
import { cgroupCommand, cgroupPopulated, ensureCgroup, killCgroup, probeCgroups, removeCgroup, workerCgroupPath } from './cgroup.ts';
import { groupEntry, groupsStillStopping, killGroups, liveGroups } from './groups.ts';
import { jobCommand, jobEmpty, probeJobs, realJobHelper, terminateJob, workerJobName, type JobHelper } from './job.ts';
import type { ChildProcess } from 'node:child_process';
import { GUARANTEE, SCOPE_CGROUP_CAP, SCOPE_GROUP_CAP, type ScopeBackend, type ScopeGuarantee, type ScopeRecord, type SpawnScope } from './scope.ts';

export type HostScope = { backend: 'cgroup'; base: string } | { backend: 'job' } | { backend: 'groups'; reason: string };

let host: HostScope | undefined;

/** This controller's backend: `cgroup` where a real probe proves delegation, else `groups`. */
export function hostScope(): HostScope {
  if (host) return host;
  host = detectHost();
  console.info(`[hsq] worker scope: ${host.backend === 'cgroup' ? `cgroup (contained) under ${host.base}`
    : host.backend === 'job' ? 'Windows Job Object (contained)'
    : `process groups (scoped: a detached descendant can outlive destroy) — ${host.reason}`}`);
  return host;
}

function detectHost(): HostScope {
  if (process.platform === 'win32') {
    const probe = probeJobs();
    return 'ok' in probe ? { backend: 'job' } : { backend: 'groups', reason: probe.reason };
  }
  const probe = process.platform === 'linux' ? probeCgroups() : { reason: `${process.platform} has no cgroups` };
  return 'base' in probe ? { backend: 'cgroup', base: probe.base } : { backend: 'groups', reason: probe.reason };
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

const key = (entry: RecordedProcess) => `${entry.pid}:${entry.startToken}`;
const capacityError = (workerId: string) => new Error(`worker ${workerId} already owns ${SCOPE_GROUP_CAP} live process groups`);

export type ScopeStop = { stopped: true } | { stopped: false; error: string };
const STOP_POLL_MS = 10;

export class WorkerScopes {
  /** This controller's job keepers, by worker: each holds its worker's job open while it runs. */
  private readonly keepers = new Map<string, ChildProcess>();
  constructor(private readonly store: ScopeStore, private readonly hostOf: () => HostScope = hostScope,
    private readonly jobs: JobHelper = realJobHelper) {}

  describe(): { backend: ScopeBackend; guarantee: ScopeGuarantee } {
    const { backend } = this.hostOf();
    return { backend, guarantee: GUARANTEE[backend] };
  }

  /** The scope every process of `workerId` starts in. The record names a cgroup before the cgroup
   * exists and before anything enters it, so a crash at any point leaves nothing unrecorded. */
  spawnScope(workerId: string): SpawnScope {
    const assertNotDestroying = (): void => {
      const run = this.store.getRun(workerId);
      if (run?.delegation?.role === 'worker' && run.delegation.destroy) throw new Error('Worker destruction has begun; nothing new starts in its scope');
    };
    const prepareCgroup = (base: string): string => {
      const path = workerCgroupPath(base, workerId);
      this.update(workerId, record => {
        if (record.cgroups.includes(path)) return record;
        if (record.cgroups.length >= SCOPE_CGROUP_CAP) throw new Error(`worker ${workerId} already spans ${SCOPE_CGROUP_CAP} cgroups`);
        return { ...record, cgroups: [...record.cgroups, path] };
      });
      return ensureCgroup(base, workerId);
    };
    const prepareJob = (): string => {
      const job = workerJobName(workerId);
      this.update(workerId, record => record.jobs.includes(job) ? record : { ...record, jobs: [job] });
      this.keeper(workerId, job);
      return job;
    };
    return {
      cgroupDir: () => {
        assertNotDestroying();
        const host = this.hostOf();
        return host.backend === 'cgroup' ? prepareCgroup(host.base) : undefined;
      },
      jobName: () => {
        assertNotDestroying();
        const host = this.hostOf();
        return host.backend === 'job' ? prepareJob() : undefined;
      },
      command: (file, args) => {
        assertNotDestroying();
        const host = this.hostOf();
        // Refused before anything runs: a full group record never has to end a started process.
        if (host.backend === 'groups' && liveGroups(this.read(workerId).groups).length >= SCOPE_GROUP_CAP) throw capacityError(workerId);
        if (host.backend === 'job') return jobCommand(prepareJob(), file, args);
        if (host.backend !== 'cgroup') return [file, [...args]];
        return cgroupCommand(prepareCgroup(host.base), file, args);
      },
      started: pid => {
        if (this.hostOf().backend !== 'groups' || process.platform === 'win32') return;
        this.update(workerId, record => {
          const live = liveGroups(record.groups);
          // Never forget a live group to make room: refuse the start instead (the caller ends it).
          if (live.length >= SCOPE_GROUP_CAP) throw capacityError(workerId);
          const entry = groupEntry(pid);
          // Without a start token the group can never be proven ours, so it could never be stopped:
          // refuse it, and the spawn site ends the group now.
          if (entry.startToken === undefined) throw new Error(`process ${pid} exited before its identity could be recorded`);
          return { ...record, groups: [...live, entry] };
        });
      },
    };
  }

  /** Whether no process the worker owns still runs: its cgroups are unpopulated and none of its
   * recorded groups has a member. An unreadable record is not empty. */
  empty(workerId: string): boolean {
    let record: ScopeRecord;
    try { record = this.read(workerId); } catch { return false; }
    return record.jobs.every(job => jobEmpty(job, this.jobs)) && !record.cgroups.some(path => cgroupPopulated(path)) &&
      !liveGroups(this.groups(workerId, record)).length;
  }

  /** After `kill`: whether nothing the worker owned still runs. A cgroup drops a task when it exits,
   * zombie or not; a group counts while its recorded leader runs (see `groupsStillStopping`). */
  stopped(workerId: string): boolean {
    let record: ScopeRecord;
    try { record = this.read(workerId); } catch { return false; }
    return record.jobs.every(job => jobEmpty(job, this.jobs)) && !record.cgroups.some(path => cgroupPopulated(path)) &&
      !groupsStillStopping(this.groups(workerId, record)).length;
  }

  /** SIGKILL everything the worker owns, now, without waiting. */
  kill(workerId: string): void {
    const record = this.read(workerId);
    for (const job of record.jobs) terminateJob(job, 0, this.jobs);
    for (const path of record.cgroups) killCgroup(path);
    killGroups(this.groups(workerId, record));
  }

  /** End everything the worker owns and remove its cgroups, within `timeoutMs`. What could not be
   * stopped stays recorded, so a retry starts from it. */
  async stop(workerId: string, timeoutMs: number): Promise<ScopeStop> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const round = await this.stopRound(workerId, deadline, timeoutMs);
      // A start admitted before destroy began can register while a round waits: stop it too.
      if (round !== 'late') return round;
      if (Date.now() >= deadline) return { stopped: false, error: `worker processes started while stopping did not stop within ${Math.round(timeoutMs / 1000)}s` };
    }
  }

  /** One kill-and-wait over the record as read now; `late` when the record gained entries meanwhile. */
  private async stopRound(workerId: string, deadline: number, timeoutMs: number): Promise<ScopeStop | 'late'> {
    let record: ScopeRecord;
    try { record = this.read(workerId); } catch (error) { return { stopped: false, error: (error as Error).message }; }
    killGroups(this.groups(workerId, record));
    const jobs: string[] = [];
    for (const job of record.jobs) {
      if (terminateJob(job, Math.max(0, deadline - Date.now()), this.jobs)) await this.release(workerId, deadline);
      else jobs.push(job);
    }
    const cgroups: string[] = [];
    for (const path of record.cgroups) if (!await removeCgroup(path, deadline)) cgroups.push(path);
    let groups = groupsStillStopping(this.groups(workerId, record));
    while (groups.length && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, STOP_POLL_MS));
      groups = groupsStillStopping(groups);
    }
    // Merged into the record as it is now: an entry written while this stop waited is kept, and only
    // what this stop ended leaves it. Groups only the execution record names stay there.
    const removed = new Set(record.cgroups.filter(path => !cgroups.includes(path)));
    const closed = new Set(record.jobs.filter(job => !jobs.includes(job)));
    const ended = new Set(record.groups.filter(group => !groups.some(left => key(left) === key(group))).map(key));
    let late = false;
    this.update(workerId, current => {
      late = current.cgroups.some(path => !record.cgroups.includes(path)) || current.jobs.some(job => !record.jobs.includes(job)) ||
        current.groups.some(group => !record.groups.some(known => key(known) === key(group)));
      return { ...current, cgroups: current.cgroups.filter(path => !removed.has(path)), jobs: current.jobs.filter(job => !closed.has(job)),
        groups: current.groups.filter(group => !ended.has(key(group))) };
    });
    if (late) return 'late';
    if (!jobs.length && !cgroups.length && !groups.length) return { stopped: true };
    return { stopped: false, error: `worker processes did not stop within ${Math.round(timeoutMs / 1000)}s: ${
      [...jobs.map(job => `job ${job}`), ...cgroups.map(path => `cgroup ${path}`), ...groups.map(group => `process group ${group.pgid}`)].join(', ')}` };
  }

  /** Starts the keeper that creates and holds the worker's job, unless one of this controller runs.
   * A command's `run` helper waits for the job to appear, so this need not wait for the keeper. */
  private keeper(workerId: string, job: string): void {
    const running = this.keepers.get(workerId);
    if (running && running.exitCode === null && running.signalCode === null) return;
    const keeper = this.jobs.keep(job);
    this.keepers.set(workerId, keeper);
    keeper.once('exit', () => { if (this.keepers.get(workerId) === keeper) this.keepers.delete(workerId); });
  }

  /** Ends this controller's keeper for the worker, and waits (until `deadline`) for it to exit: its
   * job closes with it once no process holds the job. */
  private async release(workerId: string, deadline: number): Promise<void> {
    const keeper = this.keepers.get(workerId);
    this.keepers.delete(workerId);
    if (!keeper) return;
    const exited = new Promise<void>(resolve => {
      if (keeper.exitCode !== null || keeper.signalCode !== null) resolve(); else keeper.once('exit', () => resolve());
    });
    keeper.stdin?.end();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now())).unref?.())]);
  }

  private read(workerId: string): ScopeRecord {
    const record = this.store.readWorkerScope(workerId);
    if (record === 'unknown') throw new WorkerScopeUnreadable();
    return record === 'absent' ? { workerId, cgroups: [], groups: [], jobs: [] } : record;
  }

  /** The record's groups and the current execution's recorded processes, without duplicates. A
   * worker created before scopes has its session groups only in its execution record. */
  private groups(workerId: string, record: ScopeRecord): RecordedProcess[] {
    const generation = this.store.readWorkerExecution(workerId)?.generation;
    const execution = generation ? this.store.readWorkerProcesses(workerId, generation) : 'absent';
    const seen = new Set(record.groups.map(key));
    const recorded = typeof execution === 'string' ? [] : execution.processes;
    return [...record.groups, ...recorded.filter(entry => !seen.has(key(entry)))];
  }

  private update(workerId: string, change: (record: ScopeRecord) => ScopeRecord): void {
    const record = this.read(workerId);
    const next = change(record);
    if (next !== record) this.store.writeWorkerScope(workerId, next);
  }
}
