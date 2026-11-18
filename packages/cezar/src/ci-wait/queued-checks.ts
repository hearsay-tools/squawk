import { stripTerminal } from './text.ts';

export const CI_QUEUED_BOUND_MS = 15 * 60_000;
type Check = {name: string; link: string; state: string; bucket: string};
/** Per-wait observed time, not GitHub's queue creation time. A restart starts a new clock. */
export class QueuedCheckClock {
  private readonly checks = new Map<string, {name: string; since: number}>();
  observe(rows: Check[]): void {
    const present = new Set<string>();
    for (const row of rows) {
      if (row.bucket !== 'pending' || row.state !== 'QUEUED') continue;
      const key = JSON.stringify([row.name,row.link]);
      present.add(key);
      if (!this.checks.has(key)) this.checks.set(key,{name:row.name,since:Date.now()});
    }
    for (const key of this.checks.keys()) if (!present.has(key)) this.checks.delete(key);
  }
  deadline(): number {
    return Math.min(...Array.from(this.checks.values(),check => check.since + CI_QUEUED_BOUND_MS));
  }
  diagnostic(): string | undefined {
    const now = Date.now();
    const stuck = Array.from(this.checks.values()).filter(check => now - check.since >= CI_QUEUED_BOUND_MS);
    if (!stuck.length) return undefined;
    const recovery = ' Close and reopen the PR: reopened starts a fresh pull_request_target run on the same head. Push a new head only if the new run also stays queued. The clock starts when this wait first sees a queued check; a cockpit restart restarts it.';
    let names = 'Checks still queued: ';
    let included = 0;
    for (const check of stuck) {
      const item = `${included ? '; ' : ''}${stripTerminal(check.name).slice(0,256)} (queued for at least ${Math.floor((now - check.since) / 60_000)} minutes)`;
      // Reserve space for a truncation notice and keep the recovery within 4096 bytes.
      if (Buffer.byteLength(names + item + recovery) > 4000) break;
      names += item; included++;
    }
    if (included < stuck.length) names += `; ${stuck.length - included} more queued checks (list truncated)`;
    return names + '.' + recovery;
  }
}
