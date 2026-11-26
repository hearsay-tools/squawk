import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { SESSION_CONTEXT_FILE_MAX_BYTES, type SessionContextFile } from '@open-mercato/cezar-contract/session-context';
import { fallbackProjectWriteError, readProjectPath } from './project-paths.ts';
import { parseSessionContextText } from './session-context.ts';

/**
 * The cockpit's read and write of the project's `context.yaml` (hearsay-tools/squawk#4308). It reads
 * the same path a launch reads, and writes it back in place: atomically, only over the version the
 * editor read, and only text with no problems. Fallback project data stays read only, and so does a
 * file reached through a symbolic link: a remote user could otherwise point the editor at another
 * file, such as `config.json`, and write settings that need settings administration.
 */

function hashBytes(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

type Current =
  | { exists: false; unwritable?: string }
  | { exists: true; content: string }
  | { exists: true; unreadable: string };

/** Why the file is not at its own place in the project: a link in its path, or undefined. */
async function linkedLocation(projectRoot: string, path: string): Promise<string | undefined> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return 'it is a symbolic link';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return `it cannot be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  // The nearest directory that exists must resolve to where its project-relative path says.
  const root = await realpath(projectRoot);
  let dir = dirname(path);
  for (;;) {
    try {
      const real = await realpath(dir);
      return real === join(root, relative(projectRoot, dir)) ? undefined : 'its directory is a symbolic link';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dir === projectRoot) return 'its directory cannot be read';
      dir = dirname(dir);
    }
  }
}

async function readCurrent(projectRoot: string, path: string): Promise<Current> {
  const linked = await linkedLocation(projectRoot, path);
  if (linked) {
    try { await lstat(path); return { exists: true, unreadable: linked }; } catch { return { exists: false, unwritable: linked }; }
  }
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return { exists: true, unreadable: 'it is not a regular file' };
    size = info.size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { exists: false } : { exists: true, unreadable: `it cannot be read (${code ?? 'error'})` };
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
    if (current.unwritable) {
      return { path: shown, exists: false, content: '', version: null, writable: false, readOnlyReason: `Squawk cannot edit ${shown}: ${current.unwritable}.` };
    }
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
  return answer(projectRoot, path, await readCurrent(projectRoot, path));
}

export type SessionContextWrite =
  | { ok: true; file: SessionContextFile }
  | { ok: false; status: 400 | 409 | 500; error: string };

/** One save at a time per file, so two saves over one version cannot both pass the check. */
const writing = new Map<string, Promise<unknown>>();

export function writeSessionContextFile(projectRoot: string, content: string, version: string | null): Promise<SessionContextWrite> {
  const path = readProjectPath(projectRoot, 'context.yaml');
  const previous = writing.get(path) ?? Promise.resolve();
  const next = previous.then(() => writeChecked(projectRoot, path, content, version));
  const settled = next.catch(() => undefined);
  writing.set(path, settled);
  void settled.then(() => { if (writing.get(path) === settled) writing.delete(path); });
  return next;
}

async function writeChecked(projectRoot: string, path: string, content: string, version: string | null): Promise<SessionContextWrite> {
  const before = answer(projectRoot, path, await readCurrent(projectRoot, path));
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
  // The rename replaces the path itself, never a file a link points to: the check above refuses links.
  const tmp = `${path}.hsq-tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    return { ok: false, status: 500, error: (error as Error).message };
  }
  return { ok: true, file: answer(projectRoot, path, await readCurrent(projectRoot, path)) };
}
