import { access, constants as fsConstants, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Workspace-root writability probe (multi-project spec, "API Contracts"):
 *  optional `mkdir -p`, `access W_OK`, then a real create/delete round-trip — W_OK alone
 *  can lie (e.g. a read-only mount still reports writable permission bits).
 *  Returns the failure message, or null when the directory is usable. */
export async function probeWritableDir(dir: string, create: boolean): Promise<string | null> {
  const probe = join(dir, `.cez-write-probe-${process.pid}-${Date.now().toString(36)}`);
  try {
    if (create) await mkdir(dir, { recursive: true });
    const info = await stat(dir);
    if (!info.isDirectory()) return `${dir} is not a directory`;
    await access(dir, fsConstants.W_OK);
    await writeFile(probe, '', 'utf8');
    await unlink(probe);
    return null;
  } catch (err) {
    await unlink(probe).catch(() => {}); // best-effort if the round-trip half-succeeded
    return err instanceof Error ? err.message : String(err);
  }
}
