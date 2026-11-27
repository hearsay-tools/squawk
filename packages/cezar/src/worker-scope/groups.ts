/** The `groups` backend: the worker's recorded POSIX process groups. A process that leaves its group
 * (`setsid`, Node `detached`) is outside it; ADR 0032 states that limit. */
import { processGroupRunning, signalProcessGroup } from '../core/session-process.ts';
import { pidExists, processStartToken, type RecordedProcess } from '../core/process-stat.ts';
import { groupOwned } from '../core/process-ownership.ts';

/** A group leader at spawn: its pid is its group id. */
export function groupEntry(pid: number): RecordedProcess {
  const startToken = processStartToken(pid);
  return { pid, pgid: pid, ...(startToken === undefined ? {} : { startToken }) };
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

/** After a SIGKILL to the whole group, the recorded entries that still have a running process: a
 * leader that is still the recorded incarnation, or, for a group of ours whose leader is gone, a
 * running member (a zombie whose other threads run counts: they still hold its sockets). A SIGKILL takes effect asynchronously, so a member can still hold a
 * port for a moment; a group of zombies still answers `kill(-pgid, 0)` until its reaper reaps it,
 * which an init that does not reap never does, so zombies are never waited for. */
export function groupsStillStopping(entries: readonly RecordedProcess[]): RecordedProcess[] {
  return entries.filter(entry => {
    if (entry.startToken !== undefined && pidExists(entry.pid) && processStartToken(entry.pid) === entry.startToken) return true;
    return entry.pgid !== undefined && groupOwned(entry) && processGroupRunning(entry.pgid);
  });
}

/** The recorded groups that are still ours and have a member, and the recorded processes outside
 * a group that are still the recorded incarnation. */
export function liveGroups(entries: readonly RecordedProcess[]): RecordedProcess[] {
  return entries.filter(entry => entry.pgid !== undefined ? groupOwned(entry)
    : entry.startToken !== undefined && pidExists(entry.pid) && processStartToken(entry.pid) === entry.startToken);
}
