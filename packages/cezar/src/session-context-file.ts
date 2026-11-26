import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { SESSION_CONTEXT_FILE_MAX_BYTES, type SessionContextFile } from '@open-mercato/cezar-contract/session-context';
import { fallbackProjectWriteError, readProjectPath } from './project-paths.ts';
import { parseSessionContextText } from './session-context.ts';

/**
 * The cockpit's read and write of the project's `context.yaml` (hearsay-tools/squawk#4308). It reads
 * the same path a launch reads, and writes it back in place: atomically, only over the version the
 * editor read, and only text with no problems. Fallback project data stays read only.
 */

function hashBytes(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

type Current = { exists: false } | { exists: true; content: string } | { exists: true; unreadable: string };

async function readCurrent(path: string): Promise<Current> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { exists: true, unreadable: 'it is not a regular file' };
    size = info.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // A dangling symlink is present but unreadable: never write over it.
      try { await lstat(path); return { exists: true, unreadable: 'it is a broken symbolic link' }; } catch { return { exists: false }; }
    }
    return { exists: true, unreadable: `it cannot be read (${code ?? 'error'})` };
  }
  if (size > SESSION_CONTEXT_FILE_MAX_BYTES) return { exists: true, unreadable: `it is larger than ${SESSION_CONTEXT_FILE_MAX_BYTES} bytes` };
  try {
    const bytes = await readFile(path);
    return { exists: true, content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch (error) {
    if (error instanceof TypeError) return { exists: true, unreadable: 'it is not valid UTF-8' };
    return { exists: true, unreadable: `it cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'})` };
  }
}

function answer(projectRoot: string, path: string, current: Current): SessionContextFile {
  const shown = relative(projectRoot, path);
  const fallback = fallbackProjectWriteError(path);
  if (!current.exists) {
    return { path: shown, exists: false, content: '', version: null, writable: fallback === undefined, readOnlyReason: fallback ?? null };
  }
  if ('unreadable' in current) {
    return { path: shown, exists: true, content: '', version: null, writable: false, readOnlyReason: `Squawk cannot edit ${shown}: ${current.unreadable}.` };
  }
  return {
    path: shown, exists: true, content: current.content, version: hashBytes(current.content),
    writable: fallback === undefined, readOnlyReason: fallback ?? null,
  };
}

export async function readSessionContextFile(projectRoot: string): Promise<SessionContextFile> {
  const path = readProjectPath(projectRoot, 'context.yaml');
  return answer(projectRoot, path, await readCurrent(path));
}

export type SessionContextWrite =
  | { ok: true; file: SessionContextFile }
  | { ok: false; status: 400 | 409 | 500; error: string };

export async function writeSessionContextFile(projectRoot: string, content: string, version: string | null): Promise<SessionContextWrite> {
  const path = readProjectPath(projectRoot, 'context.yaml');
  const before = answer(projectRoot, path, await readCurrent(path));
  if (!before.writable) return { ok: false, status: 409, error: before.readOnlyReason ?? `${before.path} is read only` };
  if (before.version !== version) {
    const error = before.exists
      ? 'context.yaml changed on disk since you opened it. Show the disk version, or overwrite it.'
      : 'context.yaml was deleted on disk since you opened it. Show the disk version, or overwrite it.';
    return { ok: false, status: 409, error };
  }
  const first = parseSessionContextText(content).problems[0];
  if (first) {
    const where = first.line === null ? '' : `line ${first.line}: `;
    return { ok: false, status: 400, error: `context.yaml has problems; fix them to save (${where}${first.message})` };
  }
  let target = path;
  try { target = await realpath(path); } catch { /* absent: create it at the read path */ }
  const tmp = `${target}.hsq-tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    return { ok: false, status: 500, error: (error as Error).message };
  }
  return { ok: true, file: answer(projectRoot, path, await readCurrent(path)) };
}
