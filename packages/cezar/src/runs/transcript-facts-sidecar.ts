/**
 * Sidecar commits shared by the index and the facts worker. The worker commits the sidecar its
 * load rebuilt, off the main thread. The index can revoke that commit first: after a revoke, the
 * worker renames nothing for the job, so a forgotten run never gets a late sidecar.
 */
import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';

/** Int32 slots of a job's shared signal buffer. */
export const RESULT_SLOT = 0;
export const COMMIT_SLOT = 1;
export const SIGNAL_BYTES = 8;
const OPEN = 0;
export const RENAMING = 1;
export const SETTLED = 2;
const REVOKED = 3;

/** What the worker did with the sidecar it was asked to commit. */
export type SidecarCommit = { written: boolean } | { error: string; cleaned: boolean };

export function tempSidecarPath(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

/** Worker side: write a temp file, then rename it over `path` unless the job was revoked. */
export function commitSidecar(path: string, serialized: string, signal: Int32Array): SidecarCommit {
  const tmp = tempSidecarPath(path);
  try {
    writeFileSync(tmp, serialized, { mode: 0o600 });
    if (Atomics.compareExchange(signal, COMMIT_SLOT, OPEN, RENAMING) !== OPEN) {
      rmSync(tmp, { force: true });
      return { written: false };
    }
    try { renameSync(tmp, path); } finally {
      Atomics.store(signal, COMMIT_SLOT, SETTLED);
      Atomics.notify(signal, COMMIT_SLOT);
    }
    return { written: true };
  } catch (error) {
    let cleaned = true;
    try { rmSync(tmp, { force: true }); } catch { cleaned = false; }
    return { error: (error as Error).message, cleaned };
  }
}

/** Index side: after this returns, the worker renames no sidecar for this job. A rename already
 *  under way finishes first, so a caller that removes or rewrites the sidecar next wins. The wait
 *  has no deadline: a live worker leaves RENAMING right after its rename, and a timed-out wait
 *  could let it rename later. Pass `workerAlive` false once the worker has exited; it renames
 *  nothing more, and its slot may never leave RENAMING. */
export function revokeSidecar(signal: Int32Array, workerAlive = true): void {
  if (Atomics.compareExchange(signal, COMMIT_SLOT, OPEN, REVOKED) !== RENAMING || !workerAlive) return;
  while (Atomics.load(signal, COMMIT_SLOT) === RENAMING) Atomics.wait(signal, COMMIT_SLOT, RENAMING);
}
