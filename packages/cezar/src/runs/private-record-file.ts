/** A small private JSON record beside a run (its process record, its scope record): read
 * tri-state, written durably. Only ENOENT reads as `absent`; a record that is oversized, readable
 * by others, not a regular file, or does not parse reads as `unknown`, so no caller acts on it. */
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';

export function readPrivateRecord<T>(path: string | (() => string), cap: number, parse: (value: unknown) => T): T | 'absent' | 'unknown' {
  try {
    // A path that cannot be resolved (a missing or unsafe runs directory) is classified like a read.
    const fd = openSync(typeof path === 'string' ? path : path(), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > cap || (info.mode & 0o077)) return 'unknown';
      const buffer = Buffer.alloc(cap + 1); const count = readSync(fd, buffer, 0, buffer.length, 0);
      return parse(JSON.parse(buffer.subarray(0, count).toString('utf8')));
    } finally { closeSync(fd); }
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unknown'; }
}

/** Written to a fresh private file, flushed, then renamed over `path`, so a crash leaves the old
 * record or the new one. A `path` that is not a regular file is refused, and so is any existing
 * one when `fresh`. */
export function writePrivateRecord(path: string, value: unknown, { fresh = false }: { fresh?: boolean } = {}): void {
  try {
    const existing = lstatSync(path);
    if (fresh || !existing.isFile() || existing.isSymbolicLink()) throw new Error(`Unsafe private record: ${path}`);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } finally { rmSync(temporary, { force: true }); }
}
