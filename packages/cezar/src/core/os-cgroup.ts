/** Low-level Linux cgroup v2 operations shared by worker scopes (ADR 0032) and per-session
 * containment (hearsay-tools/squawk#1345). */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
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
  /** False only when nothing is there; any other lookup failure throws: it proves no absence. */
  isDir: (path: string) => boolean;
  /** The child cgroups directly under `path`. */
  children: (path: string) => string[];
};

export const realCgroupFs: CgroupFs = {
  readFile: path => readFileSync(path, 'utf8'),
  writeFile: (path, data) => writeFileSync(path, data),
  mkdir: path => mkdirSync(path, { mode: 0o700 }),
  rmdir: path => rmdirSync(path),
  isDir: path => {
    try { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); }
    catch (error) { if (code(error) === 'ENOENT') return false; throw error; }
  },
  children: path => readdirSync(path, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(path, entry.name)),
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
  let failure: string | undefined;
  try {
    if (!place(join(probe, 'cgroup.procs'))) failure = 'cannot move a process into a child cgroup';
    else fs.writeFile(join(probe, 'cgroup.kill'), '1');
  } catch (error) { failure = `cannot kill a child cgroup (${code(error)})`; }
  // Removal is part of the proof: a host that cannot remove a cgroup cannot destroy it.
  try { fs.rmdir(probe); } catch (error) { failure ??= `cannot remove a child cgroup (${code(error)})`; }
  return failure ? { reason: failure } : { base };
}

/** A shell moves itself into the probe group and exits; exit 0 means the move worked. */
function placeProbe(procs: string): boolean {
  const result = spawnSync(SHELL, ['-c', 'echo 0 > "$0"', procs], { stdio: 'ignore', timeout: 5_000 });
  return result.status === 0;
}

const code = (error: unknown) => (error as NodeJS.ErrnoException).code ?? String(error);

/** Ensures `join(parent, name)` exists as a real directory. A non-directory entry throws. */
export function ensureNamedCgroup(parent: string, name: string, fs: CgroupFs = realCgroupFs): string {
  const path = join(parent, name);
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

/** Live PIDs currently listed in `path/cgroup.procs` and any nested child cgroups. */
export function cgroupPids(path: string, fs: CgroupFs = realCgroupFs): number[] {
  const pids: number[] = [];
  collectPids(path, fs, pids);
  return pids;
}

function collectPids(path: string, fs: CgroupFs, out: number[]): void {
  let text: string;
  try { text = fs.readFile(join(path, 'cgroup.procs')); } catch { return; }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!/^\d+$/.test(trimmed)) continue;
    const pid = Number(trimmed);
    if (pid > 1) out.push(pid);
  }
  let children: string[];
  try { children = fs.children(path); } catch { return; }
  for (const child of children) collectPids(child, fs, out);
}

/** Moves every PID currently in `from` (and nested children) into `to`, ignoring exited PIDs. */
export function moveCgroupPids(from: string, to: string, fs: CgroupFs = realCgroupFs): void {
  const target = join(to, 'cgroup.procs');
  for (const pid of cgroupPids(from, fs)) {
    try { fs.writeFile(target, String(pid)); } catch { /* process exited or cannot move */ }
  }
}

/** Removes an already-empty cgroup (and any empty children). Returns true if absent or removed. */
export function removeEmptyCgroup(path: string, fs: CgroupFs = realCgroupFs): boolean {
  try {
    if (!fs.isDir(path)) return true;
    return removeTree(path, fs) === true;
  } catch { return false; }
}

/** SIGKILL every process in `path` and its descendants now. An absent group is already empty. */
export function killCgroup(path: string, fs: CgroupFs = realCgroupFs): void {
  try { fs.writeFile(join(path, 'cgroup.kill'), '1'); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
}

/** Kill, wait until empty, remove; repeated until the group is gone or `deadline` passes. One
 * `cgroup.kill` on the cgroup ends every process in it and in its descendants, and its
 * `populated 0` covers them all; a child cgroup is then removed depth-first, since the kernel
 * removes only a cgroup without children. A process that placed itself after the kill makes a
 * removal fail with EBUSY, so the round repeats; once the group is removed no process can enter
 * it. True when the group is gone; a lookup that fails for any reason but absence answers false. */
export async function removeCgroup(path: string, deadline: number, fs: CgroupFs = realCgroupFs): Promise<boolean> {
  try {
    for (;;) {
      if (!fs.isDir(path)) return true;
      killCgroup(path, fs);
      while (cgroupPopulated(path, fs) && Date.now() < deadline) await sleep(POLL_MS);
      const removed = removeTree(path, fs);
      if (removed === true) return true;
      if (removed === 'fatal' || Date.now() >= deadline) return false;
      await sleep(POLL_MS);
    }
  } catch { return false; }
}

/** Removes `path` and its child cgroups, deepest first. `busy` when a cgroup still holds a process. */
function removeTree(path: string, fs: CgroupFs): true | 'busy' | 'fatal' {
  for (const child of fs.children(path)) {
    const removed = removeTree(child, fs);
    if (removed !== true) return removed;
  }
  try { fs.rmdir(path); return true; } catch (error) {
    if (code(error) === 'ENOENT') return true;
    return code(error) === 'EBUSY' ? 'busy' : 'fatal';
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
