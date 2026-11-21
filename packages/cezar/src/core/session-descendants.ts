import { ChildProcess, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { linuxBootId, parseProcStat, pidExists, processStartToken, statFields } from './process-stat.ts';

interface ProcessRow { pid: number; parent: number; token: string }

function processRows(): ProcessRow[] {
  if (process.platform === 'linux') {
    let names: string[];
    try { names = readdirSync('/proc'); } catch { return []; }
    const boot = linuxBootId();
    return names.filter(name => /^\d+$/.test(name)).flatMap(name => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const parsed = parseProcStat(stat);
        return parsed && parsed.state !== 'Z' ? [{ pid: Number(name), parent: Number(statFields(stat)[1]), token: boot ? `${boot}:${parsed.startToken}` : parsed.startToken }] : [];
      } catch { return []; } // A process can exit during the snapshot.
    });
  }
  if (process.platform !== 'darwin') return [];
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 2_000,
    env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  if (ps.status !== 0) return [];
  return ps.stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), token: match[3]! }] : [];
  });
}

/** Capture before cancelling a harness: detached commands can be reparented when it exits.
 * Only observed descendants with the same process incarnation are signalled. This is bounded
 * cleanup, not containment of children that escape before the first snapshot. */
export class SessionDescendants {
  private readonly members = new Map<number, string>();
  private readonly rootToken: string | undefined;
  private terminating = false;
  constructor(private readonly child: ChildProcess) {
    this.rootToken = child instanceof ChildProcess && child.pid ? this.token(child.pid) : undefined;
  }
  private token(pid: number): string | undefined {
    return processStartToken(pid);
  }
  capture(): void {
    if (!this.child.pid || !this.rootToken) return;
    const rows = processRows();
    const roots = new Set(rows.filter(row => this.members.get(row.pid) === row.token).map(row => row.pid));
    if (rows.some(row => row.pid === this.child.pid && row.token === this.rootToken)) roots.add(this.child.pid);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (roots.has(row.pid) || !roots.has(row.parent)) continue;
        roots.add(row.pid); this.members.set(row.pid, row.token); changed = true;
      }
    }
  }
  signal(signal: NodeJS.Signals): void {
    // Descendants before parents, so a dying harness cannot orphan a command first.
    for (const [pid, token] of [...this.members].reverse()) {
      if (pid <= 1 || this.token(pid) !== token || !pidExists(pid)) { this.members.delete(pid); continue; }
      try { process.kill(pid, signal); } catch { /* It exited after the identity check. */ }
    }
  }
  terminate(graceMs: number): void {
    if (this.terminating) return;
    this.terminating = true;
    this.capture(); this.signal('SIGTERM');
    if (!this.members.size) return;
    // Keep this timer after leader exit: a detached command can ignore SIGTERM.
    setTimeout(() => { this.capture(); this.signal('SIGKILL'); }, graceMs);
  }
}
