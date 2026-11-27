/**
 * Proof that a recorded process or process group is still the one Squawk started. Workers, autosave
 * cleanup and jobs share these checks; they hold no feature state.
 */
import { processGroupAlive } from './session-process.ts';
import { linuxBootId, pidExists, processStartToken, type RecordedProcess } from './process-stat.ts';

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

/** Whether the recorded group is the one Squawk started. A live leader must be the recorded
 * incarnation. A group whose leader is gone keeps its number while it has members, and the kernel
 * does not reuse a pid while a group of that number exists; a reused number needs the group to
 * empty first. So a leaderless group counts only where the record proves this boot: on Linux the
 * start token carries the boot id, and a token from another boot (or none) is refused. The
 * remaining case, the pid space wrapping within one boot while the worker lives, is ADR 0032's
 * stated residual. Elsewhere (macOS: no boot id, a small pid space) a leaderless group is never
 * signalled. */
export function groupOwned(entry: RecordedProcess): boolean {
  if (entry.pgid === undefined || entry.pgid !== entry.pid || entry.startToken === undefined || !processGroupAlive(entry.pgid)) return false;
  if (pidExists(entry.pid)) return processStartToken(entry.pid) === entry.startToken;
  const boot = process.platform === 'linux' ? linuxBootId() : undefined;
  return boot !== undefined && entry.startToken.startsWith(`${boot}:`);
}
