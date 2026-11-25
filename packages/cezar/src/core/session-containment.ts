/**
 * Per-session OS process containment (hearsay-tools/squawk#1345).
 *
 * Matches ADR 0032's host backends without scanning host processes:
 * - Linux with delegated cgroup v2: each session spawns inside `squawk-session-<id>`, nested under
 *   the worker's cgroup when inside a worker.
 * - Windows with Job Objects: each session spawns inside `Local\squawk-session-<id>` (with
 *   `JOB_OBJECT_LIMIT_BREAKAWAY_OK` and without `KILL_ON_JOB_CLOSE`), nested under the worker's
 *   Job Object when inside a worker.
 * - macOS and Linux without delegation: degrades quietly to existing process-group cleanup.
 *
 * On abnormal exit (non-zero exit, unexpected signal, Stop or forced kill), every process left in
 * the session container ends (SIGTERM grace, then SIGKILL / TerminateJobObject). On normal exit,
 * surviving detached daemons are evacuated to the parent container so they survive while the
 * empty session container is removed.
 */
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, extname, join, resolve } from 'node:path';
import {
  cgroupCommand,
  cgroupPids,
  cgroupPopulated,
  ensureNamedCgroup,
  killCgroup,
  moveCgroupPids,
  probeCgroups,
  realCgroupFs,
  removeCgroup,
  removeEmptyCgroup,
  type CgroupFs,
} from './os-cgroup.ts';
import {
  jobCommand,
  probeJobs,
  realJobHelper,
  terminateJob,
  type JobHelper,
} from './os-win-job.ts';

export const SESSION_CGROUP_PREFIX = 'squawk-session-';
export const SESSION_JOB_PREFIX = 'Local\\squawk-session-';

export type SessionContainmentHost =
  | { backend: 'cgroup'; base: string }
  | { backend: 'job' }
  | { backend: 'none' };

export type SessionContainer =
  | { kind: 'cgroup'; path: string; parent: string; fs: CgroupFs }
  | { kind: 'job'; name: string; keeper: ChildProcess; helper: JobHelper };

const CONTAINER_POLL_MS = 50;
const REMOVE_TIMEOUT_MS = 5_000;

let cachedHost: SessionContainmentHost | undefined;

/** Detect once per controller whether this host supports OS session containment. */
export function sessionContainment(
  fs: CgroupFs = realCgroupFs,
  helper: JobHelper = realJobHelper,
): SessionContainmentHost {
  if (cachedHost) return cachedHost;
  cachedHost = detectContainmentHost(fs, helper);
  return cachedHost;
}

/** Tests override or reset (`undefined`) the detected host containment backend. */
export function setSessionContainment(value: SessionContainmentHost | undefined): void {
  cachedHost = value;
}

/** True when this host places sessions in an OS process container (`cgroup` or `job`). */
export function isSessionContained(): boolean {
  return sessionContainment().backend !== 'none';
}

function detectContainmentHost(fs: CgroupFs, helper: JobHelper): SessionContainmentHost {
  if (process.platform === 'linux') {
    const probe = probeCgroups(fs);
    return 'base' in probe ? { backend: 'cgroup', base: probe.base } : { backend: 'none' };
  }
  if (process.platform === 'win32') {
    const probe = probeJobs(helper);
    return 'ok' in probe ? { backend: 'job' } : { backend: 'none' };
  }
  return { backend: 'none' };
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch { return false; }
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').filter(Boolean);
}

function isWindowsExecutable(path: string, exts: readonly string[]): boolean {
  if (existsSync(path)) {
    try { return statSync(path).isFile(); } catch { return false; }
  }
  if (extname(path)) return false;
  return exts.some(ext => {
    try { return statSync(`${path}${ext}`).isFile(); } catch { return false; }
  });
}

/** Whether `bin` resolves to an executable file on this host. Missing binaries bypass container
 * wrappers so `spawn` emits native `ENOENT`/`EACCES` directly. */
export function executableReachable(bin: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (!bin) return false;
  if (process.platform === 'win32') {
    const exts = windowsPathExts(env);
    if (bin.includes('/') || bin.includes('\\')) return isWindowsExecutable(resolve(cwd, bin), exts);
    const pathEnv = env.PATH ?? env.Path ?? process.env.PATH ?? '';
    return pathEnv.split(delimiter).filter(Boolean).some(dir => isWindowsExecutable(join(dir, bin), exts));
  }
  if (bin.includes('/')) return isExecutableFile(resolve(cwd, bin));
  const pathEnv = env.PATH ?? process.env.PATH ?? '';
  return pathEnv.split(delimiter).filter(Boolean).some(dir => isExecutableFile(join(dir, bin)));
}

export interface PrepareContainerOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  parentCgroup?: string | undefined;
  parentJob?: string | undefined;
  fs?: CgroupFs | undefined;
  helper?: JobHelper | undefined;
}

export interface PreparedSessionLaunch {
  file: string;
  argv: string[];
  container: SessionContainer | undefined;
}

/** Wraps `(bin, args)` in a per-session OS container when supported and `bin` is reachable. */
export function prepareSessionContainer(
  bin: string,
  args: readonly string[],
  options: PrepareContainerOptions,
): PreparedSessionLaunch {
  const plain: PreparedSessionLaunch = { file: bin, argv: [...args], container: undefined };
  if (!executableReachable(bin, options.cwd, options.env)) return plain;
  const fs = options.fs ?? realCgroupFs;
  const helper = options.helper ?? realJobHelper;
  const host = sessionContainment(fs, helper);
  if (host.backend === 'cgroup') {
    const parent = options.parentCgroup ?? host.base;
    try {
      const path = ensureNamedCgroup(parent, `${SESSION_CGROUP_PREFIX}${randomUUID()}`, fs);
      const [file, argv] = cgroupCommand(path, bin, args);
      return { file, argv, container: { kind: 'cgroup', path, parent, fs } };
    } catch { return plain; }
  }
  if (host.backend === 'job') {
    const name = `${SESSION_JOB_PREFIX}${randomUUID()}`;
    let keeper: ChildProcess | undefined;
    try {
      keeper = helper.keep(name, 'keep-session');
      const jobs = options.parentJob ? [options.parentJob, name] : name;
      const [file, argv] = jobCommand(jobs, bin, args);
      return { file, argv, container: { kind: 'job', name, keeper, helper } };
    } catch {
      if (keeper) endKeeper(keeper);
      return plain;
    }
  }
  return plain;
}

function endKeeper(keeper: ChildProcess): void {
  try { keeper.stdin?.end(); } catch { /* already closed */ }
}

/** Clean up a container whose spawn never succeeded or returned a non-ChildProcess mock. */
export function discardSessionContainer(container: SessionContainer | undefined): void {
  if (!container) return;
  if (container.kind === 'cgroup') removeEmptyCgroup(container.path, container.fs);
  else endKeeper(container.keeper);
}

/** Normal session exit: evacuate surviving detached processes up to the parent container and
 * remove the empty session container without signalling them. */
export function releaseSessionContainer(container: SessionContainer | undefined): void {
  if (!container) return;
  if (container.kind === 'job') { endKeeper(container.keeper); return; }
  for (let attempt = 0; attempt < 3; attempt++) {
    moveCgroupPids(container.path, container.parent, container.fs);
    if (removeEmptyCgroup(container.path, container.fs)) return;
  }
}

/** Forward a signal to live processes in a session container (used on Squawk shutdown or probe kill). */
export function signalSessionContainer(container: SessionContainer | undefined, signal: NodeJS.Signals): void {
  if (!container) return;
  if (container.kind === 'job') {
    if (signal === 'SIGKILL') {
      try { terminateJob(container.name, 0, container.helper); } catch { /* best-effort */ }
    }
    return;
  }
  if (signal === 'SIGKILL') {
    try { killCgroup(container.path, container.fs); } catch { /* already gone */ }
    return;
  }
  for (const pid of cgroupPids(container.path, container.fs)) {
    try { process.kill(pid, signal); } catch { /* exited */ }
  }
}

/** Abnormal session exit: SIGTERM remaining processes in the container, wait up to `graceMs`
 * (exiting immediately once empty), then force-kill and remove the container. Uses referenced
 * timers so a short-lived host (`hsq run`) stays up until detached MCP servers are gone. */
export function reapSessionContainer(container: SessionContainer | undefined, graceMs: number): void {
  if (!container) return;
  if (container.kind === 'job') {
    try { terminateJob(container.name, Math.max(0, graceMs), container.helper); } catch { /* best-effort */ }
    endKeeper(container.keeper);
    return;
  }
  if (!cgroupPopulated(container.path, container.fs)) {
    removeEmptyCgroup(container.path, container.fs);
    return;
  }
  if (graceMs <= 0) {
    void removeCgroup(container.path, Date.now() + REMOVE_TIMEOUT_MS, container.fs);
    return;
  }
  signalSessionContainer(container, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  const check = (): void => {
    if (!cgroupPopulated(container.path, container.fs)) {
      if (removeEmptyCgroup(container.path, container.fs)) return;
    }
    const left = deadline - Date.now();
    if (left > 0) setTimeout(check, Math.min(CONTAINER_POLL_MS, left));
    else void removeCgroup(container.path, Date.now() + REMOVE_TIMEOUT_MS, container.fs);
  };
  setTimeout(check, Math.min(CONTAINER_POLL_MS, graceMs));
}
