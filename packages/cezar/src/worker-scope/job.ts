/** The Windows `job` backend: one named Job Object per worker (ADR 0032). A keeper process holds
 * the job's only lasting handle with KILL_ON_JOB_CLOSE; the controller holds the keeper's stdin, so
 * the worker's processes end with the controller (product decision 4). Each command starts inside
 * the job at creation through `scripts/windows-worker-job.ps1 run`. */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POWERSHELL, powershellEnv } from '../core/process-stat.ts';

const script = fileURLToPath(new URL('../../scripts/windows-worker-job.ps1', import.meta.url));
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];

/** The job's name in this session's namespace. */
export function workerJobName(workerId: string): string {
  return `Local\\squawk-worker-${workerId}`;
}

/** What the backend runs; tests replace it. */
export type JobHelper = {
  /** Start the keeper that creates and holds `job`; it ends when its stdin closes. */
  keep: (job: string) => ChildProcess;
  /** A synchronous helper operation's stdout. */
  call: (args: string[], timeoutMs: number) => string;
};

export const realJobHelper: JobHelper = {
  keep: job => {
    const keeper = spawn(POWERSHELL, [...POWERSHELL_ARGS, 'keep', job], { env: powershellEnv(), stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    keeper.on('error', () => undefined);
    keeper.unref();
    // The pipe must not hold the controller's event loop open; its end is the job's end.
    (keeper.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    return keeper;
  },
  call: (args, timeoutMs) => execFileSync(POWERSHELL, [...POWERSHELL_ARGS, ...args], {
    env: powershellEnv(), encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024,
  }).trim(),
};

/** The argv that runs `file args` inside `job`. The command's own argv travels in a private file the
 * helper reads and deletes, so the wrapper's command line stays short whatever the prompt. */
export function jobCommand(job: string, file: string, args: readonly string[]): [string, string[]] {
  const argvFile = join(tmpdir(), `squawk-worker-argv-${randomUUID()}`);
  writeFileSync(argvFile, [file, ...args].join('\0'), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return [POWERSHELL, [...POWERSHELL_ARGS, 'run', job, argvFile]];
}

/** Whether this host lets this user create a job and start a process inside it at creation. */
export function probeJobs(helper: JobHelper = realJobHelper): { ok: true } | { reason: string } {
  try {
    return helper.call(['probe'], 60_000) === 'ok' ? { ok: true } : { reason: 'the job probe did not confirm' };
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
