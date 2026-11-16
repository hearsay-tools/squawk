/** What a worker scope is: the set of OS containers that hold every process Squawk starts for one
 * worker, and the record that names them. ADR 0032. */
import { z } from 'zod';

/** How a host contains a worker. `cgroup`: a private Linux cgroup, which every descendant inherits.
 * `job`: a Windows Job Object, which every descendant joins at creation and cannot leave.
 * `groups`: the worker's own POSIX process groups, which a detached descendant can leave. */
export type ScopeBackend = 'cgroup' | 'job' | 'groups';
/** `contained`: stopping the scope ends every descendant. `scoped`: it ends the recorded groups
 * only; a descendant that left them survives. */
export type ScopeGuarantee = 'contained' | 'scoped';
export const GUARANTEE: Readonly<Record<ScopeBackend, ScopeGuarantee>> = { cgroup: 'contained', job: 'contained', groups: 'scoped' };

/** Recorded groups kept per worker. A dead group is dropped before a new one is added. */
export const SCOPE_GROUP_CAP = 64;
/** Recorded cgroups kept per worker: one per controller cgroup it was spawned from. */
export const SCOPE_CGROUP_CAP = 8;

const recordedGroupSchema = z.object({ pid: z.number().int().positive(), startToken: z.string().min(1).max(128).optional(),
  pgid: z.number().int().positive().optional() }).strict();

/** Everything one worker owns. It holds both kinds, so a worker started under one backend and
 * continued under another (a controller restarted elsewhere) is stopped whole. */
export const scopeRecordSchema = z.object({
  workerId: z.string().uuid(),
  cgroups: z.array(z.string().startsWith('/sys/fs/cgroup/').max(4096)).max(SCOPE_CGROUP_CAP),
  groups: z.array(recordedGroupSchema).max(SCOPE_GROUP_CAP),
  /** Windows Job Object names; a record written before the `job` backend has none. */
  jobs: z.array(z.string().regex(/^Local\\squawk-worker-[0-9a-f-]{36}$/)).max(1).default([]),
}).strict();
export type ScopeRecord = z.infer<typeof scopeRecordSchema>;

/** What a spawn site needs: the argv that runs a command inside the scope, and a report of the
 * process it started. `command` may throw; the caller then starts nothing. */
export interface SpawnScope {
  command(file: string, args: readonly string[]): [string, string[]];
  started(pid: number): void;
}
