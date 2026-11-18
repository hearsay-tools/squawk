import { productName } from '../home/display.ts';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isJobExitFile } from './job-exit-file.ts';

/**
 * A process wait's exit file (hearsay-tools/cezarion#1446, spec 2026-10-17-unified-waits § Process
 * wait decisions). The agent's own shell writes the command's exit code to it, since Squawk cannot
 * read a non-child's status. It must sit in the run's worktree or its Squawk temp directory, no
 * symlink may lead out of them, and only an integer first line ever leaves it. The one exception
 * is an `hsq job` exit file in any `--dir`: its name carries the waited PID and a job record sits
 * beside it (hearsay-tools/squawk#3909).
 */
export type ExitFileRoots = { worktree: string; tmpDir?: string };

const EXIT_FILE_READ_MAX = 64;
const INT32 = /^-?\d{1,10}$/;

function real(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** The path with every existing ancestor resolved, so a missing tail still meets its symlinks. */
function realThroughAncestors(path: string): string {
  let existing = path; const tail: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) { tail.unshift(existing.slice(dirname(existing).length + 1)); existing = dirname(existing); }
  return tail.length ? join(real(existing), ...tail) : real(existing);
}

function rootsOf(roots: ExitFileRoots): string[] {
  return [roots.worktree, ...(roots.tmpDir === undefined ? [] : [roots.tmpDir])];
}

/** Whether `absolute` is the exit file of the `hsq job` whose supervisor is `pid`. Its last name
 *  must not be a symlink: the job's supervisor writes the file itself. */
function jobExitFile(absolute: string, pid: number): boolean {
  if (realThroughAncestors(absolute) !== join(real(dirname(absolute)), basename(absolute))) return false;
  return isJobExitFile(absolute, pid);
}

/** Resolve `path` (absolute, or relative to the worktree) and check it stays inside a root, or is
 *  the exit file of the job `pid` names. */
export function confineExitFile(path: string, roots: ExitFileRoots, pid?: number): { ok: true; path: string } | { ok: false; allowed: string[] } {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(roots.worktree, path);
  const resolved = realThroughAncestors(absolute);
  const inside = rootsOf(roots).map(real).some(root => resolved === root || resolved.startsWith(root + sep));
  return inside || (pid !== undefined && jobExitFile(absolute, pid)) ? { ok: true, path: absolute } : { ok: false, allowed: rootsOf(roots) };
}

/**
 * Whether the exit file holds anything yet and, when its first line is a 32-bit integer, the code.
 * An empty file reads as absent: a shell's `echo $? > file` creates the file before it writes the
 * code (hearsay-tools/squawk#2904). Reads at most 64 bytes. Throws when the path now resolves
 * outside the roots (a symlink swapped in after registration), so the caller reports an error
 * instead of reading it.
 */
export function readExitCode(path: string, roots: ExitFileRoots, pid?: number): { present: false } | { present: true; exitCode?: number } {
  if (!existsSync(path)) return { present: false };
  if (!confineExitFile(path, roots, pid).ok) throw new Error(`the exit file now resolves outside the worktree and the ${productName('Cezar')} temp directory, and no job record beside it names it`);
  // Non-blocking: a FIFO with no writer would block a plain open, and this runs on the server's
  // event loop. The opened descriptor, not a path stat, decides, so a file swapped in between
  // the two cannot slip past.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) return { present: true };
    const buffer = Buffer.alloc(EXIT_FILE_READ_MAX);
    const read = readSync(fd, buffer, 0, EXIT_FILE_READ_MAX, 0);
    if (read === 0) return { present: false };
    const text = buffer.subarray(0, read).toString('utf8');
    // A file longer than the read has no line end inside it: the first line is not all here.
    const newline = text.indexOf('\n');
    if (newline < 0 && fstatSync(fd).size > read) return { present: true };
    const first = (newline < 0 ? text : text.slice(0, newline)).trim();
    if (!INT32.test(first)) return { present: true };
    const code = Number(first);
    return code >= -2147483648 && code <= 2147483647 ? { present: true, exitCode: code } : { present: true };
  } finally { closeSync(fd); }
}
