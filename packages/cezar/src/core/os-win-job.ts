/** Low-level Windows Job Object helpers shared by worker scopes (ADR 0032), per-session
 * containment (hearsay-tools/squawk#1345) and `hsq job start` breakaway. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POWERSHELL, powershellEnv } from './process-stat.ts';

const script = fileURLToPath(new URL('../../scripts/windows-worker-job.ps1', import.meta.url));
/** The helper DLL the probe compiled, passed by path to every later call: a worker's environment
 * has its own temp directory, where the cache is not. */
let compiled: string | undefined;
const powershellArgs = () => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...(compiled ? ['-Assembly', compiled] : [])];

export type JobKeepMode = 'keep' | 'keep-session';

/** What the backend runs; tests replace it. */
export type JobHelper = {
  /** Start the keeper that creates and holds `job`; it ends when its stdin closes. */
  keep: (job: string, mode?: JobKeepMode) => ChildProcess;
  /** A synchronous helper operation's stdout. */
  call: (args: string[], timeoutMs: number) => string;
};

export const realJobHelper: JobHelper = {
  keep: (job, mode = 'keep') => {
    const keeper = spawn(POWERSHELL, [...powershellArgs(), mode, job], { env: powershellEnv(), stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    keeper.on('error', () => undefined);
    keeper.unref();
    // The pipe must not hold the controller's event loop open; its end is the job's end.
    (keeper.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    return keeper;
  },
  call: (args, timeoutMs) => execFileSync(POWERSHELL, [...powershellArgs(), ...args], {
    env: powershellEnv(), encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024,
  }).trim(),
};

function writeArgvFile(prefix: string, file: string, args: readonly string[]): string {
  const argvFile = join(tmpdir(), `${prefix}-${randomUUID()}`);
  writeFileSync(argvFile, [file, ...args].join('\0'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return argvFile;
}

/** The argv that runs `file args` inside one or more named jobs (`workerJob`, or `[workerJob, sessionJob]`).
 * The command's own argv travels in a private file the helper reads and deletes, so the wrapper's
 * command line stays short whatever the prompt. */
export function jobCommand(jobs: string | readonly string[], file: string, args: readonly string[]): [string, string[]] {
  const jobArg = typeof jobs === 'string' ? jobs : jobs.join(',');
  const argvFile = writeArgvFile('squawk-worker-argv', file, args);
  return [POWERSHELL, [...powershellArgs(), 'run', jobArg, argvFile]];
}

/** Starts `file args` detached with `CREATE_BREAKAWAY_FROM_JOB`, returning the spawned PID.
 * Breaks out of a session job (`JOB_OBJECT_LIMIT_BREAKAWAY_OK`) while remaining inside any outer
 * worker job (which disallows breakaway). */
export function startBreakawayProcess(file: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv, helper: JobHelper = realJobHelper): number {
  const argvFile = writeArgvFile('squawk-breakaway-argv', file, args);
  const out = helper === realJobHelper
    ? execFileSync(POWERSHELL, [...powershellArgs(), 'breakaway', argvFile], {
      cwd, env: powershellEnv(env), encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024,
    }).trim()
    : helper.call(['breakaway', argvFile], 30_000);
  const pid = Number(out);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`unexpected breakaway pid: ${out}`);
  return pid;
}

/** Whether this host lets this user create a job and start a process inside it at creation. */
export function probeJobs(helper: JobHelper = realJobHelper): { ok: true } | { reason: string } {
  try {
    const [state, ...dll] = helper.call(['probe'], 60_000).split(' ');
    if (state !== 'ok') return { reason: 'the job probe did not confirm' };
    if (dll.length) compiled = dll.join(' ');
    return { ok: true };
  } catch (error) { return { reason: `cannot run a process inside a job (${(error as Error).message.split('\n')[0]})` }; }
}

/** End every process in `job` and wait up to `waitMs`: true when none is left or the job is gone. */
export function terminateJob(job: string, waitMs: number, helper: JobHelper = realJobHelper): boolean {
  const state = helper.call(['terminate', job, String(waitMs)], waitMs + 60_000);
  return state === 'empty' || state === 'absent';
}

/** Whether `job` holds no process (a job that is gone holds none). */
export function jobEmpty(job: string, helper: JobHelper = realJobHelper): boolean {
  const state = helper.call(['query', job], 60_000);
  return state === 'absent' || state === '0';
}
