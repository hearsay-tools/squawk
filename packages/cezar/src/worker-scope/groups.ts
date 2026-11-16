/** The `groups` backend: the worker's recorded POSIX process groups. A process that leaves its group
 * (`setsid`, Node `detached`) is outside it; ADR 0032 states that limit. */
import { processGroupAlive, signalProcessGroup } from '../core/session-process.ts';
import { pidExists, processStartToken, type RecordedProcess } from '../core/process-stat.ts';

/** A group leader at spawn: its pid is its group id. */
export function groupEntry(pid: number): RecordedProcess {
  const startToken = processStartToken(pid);
  return { pid, pgid: pid, ...(startToken === undefined ? {} : { startToken }) };
}

/** Whether the recorded group is still the one Squawk started. A live leader must be the recorded
 * incarnation. A group whose leader is gone keeps its id: the kernel does not reuse a pid while a
 * group of that id has a member, so only a live process at that pid with another start token means
 * the number was reused. */
export function groupOwned(entry: RecordedProcess): boolean {
  if (entry.pgid === undefined || entry.pgid !== entry.pid || !processGroupAlive(entry.pgid)) return false;
  if (!pidExists(entry.pid)) return true;
  return entry.startToken !== undefined && processStartToken(entry.pid) === entry.startToken;
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
