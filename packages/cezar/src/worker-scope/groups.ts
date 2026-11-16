/** The `groups` backend: the worker's recorded POSIX process groups. A process that leaves its group
 * (`setsid`, Node `detached`) is outside it; ADR 0032 states that limit. */
import { processGroupAlive, signalProcessGroup } from '../core/session-process.ts';
import { linuxBootId, pidExists, processStartToken, type RecordedProcess } from '../core/process-stat.ts';

/** A group leader at spawn: its pid is its group id. */
export function groupEntry(pid: number): RecordedProcess {
  const startToken = processStartToken(pid);
  return { pid, pgid: pid, ...(startToken === undefined ? {} : { startToken }) };
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

/** SIGKILL every recorded group that is still ours, and every recorded process outside a group
 * that is still the recorded incarnation. */
export function killGroups(entries: readonly RecordedProcess[]): void {
  for (const entry of entries) {
    if (entry.pgid !== undefined) { if (groupOwned(entry)) signalProcessGroup(entry.pgid, 'SIGKILL'); }
    else if (entry.startToken !== undefined && processStartToken(entry.pid) === entry.startToken) {
      try { process.kill(entry.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/** The recorded groups that are still ours and have a member, and the recorded processes outside
 * a group that are still the recorded incarnation. */
export function liveGroups(entries: readonly RecordedProcess[]): RecordedProcess[] {
  return entries.filter(entry => entry.pgid !== undefined ? groupOwned(entry)
    : entry.startToken !== undefined && pidExists(entry.pid) && processStartToken(entry.pid) === entry.startToken);
}
