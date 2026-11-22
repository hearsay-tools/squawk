import { spawnSync } from 'node:child_process';
import { readdirSync, realpathSync, readlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { linuxBootId, type RecordedProcess } from '../core/process-stat.ts';

/**
 * Synchronous process evidence: the boot check for recorded processes, and the cwd scan that
 * autosave cleanup still uses. Worker ownership never comes from the scan (ADR 0032).
 * Unreadable cwd is no evidence; other uncertainty stays alive or unknown, never proven gone.
 */

const LINUX_BOOT_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
/** A known different boot proves that no descendant of this controller can still exist. */
function controllerPredatesBoot(token: string | undefined, boot: string | undefined): boolean {
  const recordedBoot = token?.match(/^(.+):\d+$/)?.[1];
  return recordedBoot !== undefined && boot !== undefined && LINUX_BOOT_ID.test(recordedBoot) && LINUX_BOOT_ID.test(boot) && recordedBoot !== boot;
}
/** A different recorded Linux boot proves every original process group ended. */
export function processPredatesCurrentBoot(entry: RecordedProcess): boolean {
  return process.platform === 'linux' && controllerPredatesBoot(entry.startToken, linuxBootId());
}

/** The `/proc` reads the Linux scan makes; injectable for platform/error boundary coverage. */
export type ProcReader = { readdir: () => string[]; readlink: (pid: string) => string };
/** The darwin scan: `lsof` for every process's working directory. */
export type DarwinReader = { lsof: () => { ok: boolean; stdout: string } };
const lsofCwd = (args: string[], timeout: number) => {
  const lsof = spawnSync('lsof', [...args, '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  // Status 1 is ordinary: some process was unreadable, and an unreadable cwd is no evidence.
  return { ok: !lsof.error && (lsof.status === 0 || lsof.status === 1) && !!lsof.stdout, stdout: lsof.stdout ?? '' };
};
const realDarwin: DarwinReader = {
  lsof: () => lsofCwd(['-a'], 5_000),
};

const realProc: ProcReader = {
  readdir: () => readdirSync('/proc'),
  readlink: pid => readlinkSync(`/proc/${pid}/cwd`),
};

/** Each other process's readable working directory, by pid, or `unknown` when none can be listed. */
export type CwdSnapshot = ReadonlyMap<number, string> | 'unknown';
/** Every other process's readable working directory, in one scan pass; `unknown` when the
 * processes cannot be listed at all. An unreadable cwd is no evidence (hearsay-tools/cezarion#889):
 * a process that vanished, another user's, or a non-dumpable one of ours (login `sshd`,
 * `systemd --user`, `gpg-agent`, which every host has) is skipped, as `lsof` skips what it cannot
 * read. win32 has no cwd scan and answers none: Windows refuses to delete a directory a process
 * holds, so the checked removal is the proof there, beside the recorded processes. */
export function scanProcessCwds(platform: NodeJS.Platform = process.platform, proc: ProcReader = realProc, darwin: DarwinReader = realDarwin): CwdSnapshot {
  const found = new Map<number, string>();
  if (platform === 'win32') return found;
  if (platform === 'linux') {
    let entries: string[];
    try { entries = proc.readdir(); } catch { return 'unknown'; }
    for (const entry of entries) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
      try { found.set(Number(entry), proc.readlink(entry)); } catch { /* unreadable: no evidence */ }
    }
    return found;
  }
  if (platform !== 'darwin') return 'unknown';
  const lsof = darwin.lsof();
  if (!lsof.ok) return 'unknown';
  let pid: number | undefined;
  for (const line of lsof.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== undefined && pid !== process.pid) found.set(pid, line.slice(1));
  }
  return found;
}

/** PIDs (never this process) whose readable working directory is one of `dirs` or beneath it.
 * Squawk's own short-lived git children in a worktree make this read "alive" briefly:
 * conservative, and a retry self-heals. */
export function processesWithCwdUnder(dirs: string | readonly string[], platform: NodeJS.Platform = process.platform, proc: ProcReader = realProc,
  darwin: DarwinReader = realDarwin): number[] | 'unknown' {
  const snapshot = scanProcessCwds(platform, proc, darwin);
  if (snapshot === 'unknown') return 'unknown';
  const targets = (typeof dirs === 'string' ? [dirs] : dirs).map(dir => { try { return realpathSync(dir); } catch { return resolve(dir); } });
  const under = (cwd: string) => { const path = cwd.replace(/ \(deleted\)$/, ''); return targets.some(target => path === target || path.startsWith(target + sep)); };
  return [...snapshot].filter(([, cwd]) => under(cwd)).map(([pid]) => pid);
}
