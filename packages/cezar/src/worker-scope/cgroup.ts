/** The Linux `cgroup` backend: one private cgroup v2 child per worker, under the controller's own
 * cgroup. A process places itself before its command runs, so every descendant inherits the
 * group, detached ones too, and `cgroup.kill` ends them all (ADR 0032). */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CGROUP_ROOT = '/sys/fs/cgroup';
const SHELL = '/bin/sh';
/** `$0` is the target `cgroup.procs`; `0` names the writer, the shell itself, which then becomes
 * the command through `exec` (same pid). A failed move ends the shell before the command runs. */
const PLACE = 'echo 0 > "$0" && exec "$@"';
const POLL_MS = 10;

/** What cgroup operations read and write; tests replace it. */
export type CgroupFs = {
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
  mkdir: (path: string) => void;
  rmdir: (path: string) => void;
  isDir: (path: string) => boolean;
};
export const realCgroupFs: CgroupFs = {
  readFile: path => readFileSync(path, 'utf8'),
  writeFile: (path, data) => writeFileSync(path, data),
  mkdir: path => mkdirSync(path, { mode: 0o700 }),
  rmdir: path => rmdirSync(path),
  isDir: path => { try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } },
};

/** The cgroup v2 directory this process is in, from `/proc/self/cgroup`. Undefined on cgroup v1,
 * a hybrid host without a unified entry, or a path that leaves the hierarchy. */
export function ownCgroup(fs: CgroupFs = realCgroupFs): string | undefined {
  let text: string;
  try { text = fs.readFile('/proc/self/cgroup'); } catch { return undefined; }
  const line = text.split('\n').find(entry => entry.startsWith('0::/'));
  if (!line) return undefined;
  const path = line.slice(3).trim();
  if (path.split('/').includes('..')) return undefined;
  return path === '/' ? CGROUP_ROOT : join(CGROUP_ROOT, path);
}

/** The argv that runs `file args` inside the cgroup at `path`. */
export function cgroupCommand(path: string, file: string, args: readonly string[]): [string, string[]] {
  return [SHELL, ['-c', PLACE, join(path, 'cgroup.procs'), file, ...args]];
}

/** Whether this host lets the controller create, enter, kill and remove a child cgroup. A writable
 * mount alone is no proof, so the probe does each step for real; any failure answers why. */
export function probeCgroups(fs: CgroupFs = realCgroupFs, place: (procs: string) => boolean = placeProbe): { base: string } | { reason: string } {
  const base = ownCgroup(fs);
  if (!base) return { reason: 'no cgroup v2 entry in /proc/self/cgroup' };
  const probe = join(base, `squawk-probe-${randomUUID()}`);
  try { fs.mkdir(probe); } catch (error) { return { reason: `cannot create a child cgroup (${code(error)})` }; }
  try {
    if (!place(join(probe, 'cgroup.procs'))) return { reason: 'cannot move a process into a child cgroup' };
    fs.writeFile(join(probe, 'cgroup.kill'), '1');
    return { base };
  } catch (error) {
    return { reason: `cannot kill a child cgroup (${code(error)})` };
  } finally {
    try { fs.rmdir(probe); } catch { /* an empty probe group the next probe never reuses */ }
  }
}

/** A shell moves itself into the probe group and exits; exit 0 means the move worked. */
function placeProbe(procs: string): boolean {
  const result = spawnSync(SHELL, ['-c', 'echo 0 > "$0"', procs], { stdio: 'ignore', timeout: 5_000 });
  return result.status === 0;
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? String(error);

/** Where the worker's cgroup lives under `base`. */
export function workerCgroupPath(base: string, workerId: string): string {
  return join(base, `squawk-worker-${workerId}`);
}

/** The worker's cgroup under `base`, created when absent. A path that exists as anything but a
 * real directory throws: it is not ours. */
export function ensureCgroup(base: string, workerId: string, fs: CgroupFs = realCgroupFs): string {
  const path = workerCgroupPath(base, workerId);
  if (fs.isDir(path)) return path;
  fs.mkdir(path);
  return path;
}

/** Whether `path` still holds a process; an absent group holds none. */
export function cgroupPopulated(path: string, fs: CgroupFs = realCgroupFs): boolean {
  let events: string;
  try { events = fs.readFile(join(path, 'cgroup.events')); } catch (error) {
    if (code(error) === 'ENOENT') return false;
    throw error;
  }
  return /(?:^|\n)populated 1(?:\n|$)/.test(events);
}

/** SIGKILL every process in `path` and its descendants now. An absent group is already empty. */
export function killCgroup(path: string, fs: CgroupFs = realCgroupFs): void {
  try { fs.writeFile(join(path, 'cgroup.kill'), '1'); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
}

/** Kill, wait until empty, remove; repeated until the group is gone or `deadline` passes. A process
 * that placed itself after a kill makes the removal fail with EBUSY, so it is killed in turn; once
 * the group is removed no process can enter it. True when the group is gone. */
export async function removeCgroup(path: string, deadline: number, fs: CgroupFs = realCgroupFs): Promise<boolean> {
  for (;;) {
    if (!fs.isDir(path)) return true;
    killCgroup(path, fs);
    while (cgroupPopulated(path, fs) && Date.now() < deadline) await sleep(POLL_MS);
    try { fs.rmdir(path); return true; } catch (error) {
      if (code(error) === 'ENOENT') return true;
      if (code(error) !== 'EBUSY' || Date.now() >= deadline) return false;
    }
    await sleep(POLL_MS);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
