/**
 * The pinned and read flags of the run store (hearsay-tools/squawk#4041): the user's pin, the read
 * receipt and its bulk stamp. `RunStore` keeps one of these as `store.readFlags`. The `pin` and
 * `unpin` holds that keep a run loaded are not here.
 */
import type { RunRecord } from '@open-mercato/cezar-contract';
import { automationIdOf } from '@open-mercato/cezar-contract/runs';
import { UNREAD_RUN_RULE } from '@open-mercato/cezar-contract/run-predicates';
import { guardedJsonSql } from './guarded-json-sql.ts';
import { snapshotRun } from './lifecycle.ts';
import type { RunReadFlags } from './ports.ts';
import { clearPin } from './record-write-rules.ts';
import { rowFamily } from './run-claims.ts';
import type { RunDatabase } from './run-database.ts';

/** What the topic asks of the store; no import of `store.ts` values. */
export interface ReadFlagsState {
  /** The open database; null for an unavailable or closed store. */
  db(): RunDatabase | null;
  readonly held: ReadonlyMap<string, RunRecord>;
  readonly deleted: ReadonlySet<string>;
  record(id: string): RunRecord | undefined;
  claimFamilies(families: Iterable<string>): Set<string>;
  touch(run: RunRecord, before: Readonly<RunRecord> | undefined): void;
  /** A debounced write of the held record `id`: `apply` changes it in place, then `touch` saves it. */
  change(id: string, apply: (run: RunRecord) => void): RunRecord | undefined;
}

export class RunReadFlagsTopic implements RunReadFlags {
  constructor(private readonly state: ReadFlagsState) {}

  /** Pin one run to the top of this project's task list, or unpin it (#935). Mirrors
   *  `setArchived`: sets the fields, then persists + broadcasts via `touch`, so the updated
   *  record rides the existing `run` SSE with no new event. Idempotent — re-pinning a pinned
   *  run just re-stamps `pinnedAt`.
   *
   *  Every active status is pinnable. Archived requests clear stale metadata instead, so a
   *  late click racing archive cannot leave a hidden pin that reappears on unarchive. */
  setPinned(id: string, pinned: boolean): RunRecord | undefined {
    return this.state.change(id, (run) => {
      if (pinned && !run.archived) {
        run.pinned = true;
        run.pinnedAt = new Date().toISOString();
      } else {
        clearPin(run);
      }
    });
  }

  /** Mark one run as read (#unread-done-items): stamp the read receipt now. Mirrors
   *  `setArchived` — sets the field then persists + broadcasts via `touch`, so the
   *  updated record rides the existing `run` SSE with no new event. Idempotent by
   *  design: opening an already-read thread just re-stamps a later `seenAt`. */
  setRead(id: string): RunRecord | undefined {
    return this.state.change(id, (run) => { run.seenAt = new Date().toISOString(); });
  }

  /** Mark one run as UNread (#775): drop the read receipt so the run rejoins the unread
   *  list. The inverse of `setRead` and, like it, `touch`es so the updated record rides the
   *  existing `run` SSE.
   *
   *  Deleting the field rather than adding a "manually unread" flag is the whole point:
   *  absent `seenAt` is ALREADY what every reader treats as unread (`isUnread` in the
   *  cockpit's read-state.ts, and `markAllRead`'s clause-for-clause copy of it below), so
   *  clearing needs no new state and writes a shape any older Squawk already parses.
   *
   *  Deliberately unconditional: clearing a receipt is always a legal write, so this
   *  succeeds for an already-unread run (idempotent) and for statuses that can never wear
   *  the marker. WHETHER the action means anything for a given run is UI policy, and lives
   *  in the cockpit's `runActionFlags` — the same split the rest of the store keeps. */
  setUnread(id: string): RunRecord | undefined {
    return this.state.change(id, (run) => { delete run.seenAt; });
  }

  /**
   * Stamp unread finished runs in bulk and return the count. Keep the rule aligned with cockpit
   * isUnread: done/failed, finished since seen, not archived; cancelled and usage-limit waiting
   * runs are excluded. `automation` narrows it to one origin, as in `archiveFinished`
   * (hearsay-tools/cezarion#1616); absent stamps both.
   */
  markAllRead(automation?: boolean): number {
    const now = new Date().toISOString();
    let count = 0;
    // Runs not in memory are picked by the same rule over their stored summary, then re-checked
    // on the record before they are stamped.
    const candidates = [...this.state.held.values()];
    const stored = (this.state.db()?.listWhere(guardedJsonSql(UNREAD_RUN_RULE.sql, 0)) ?? []).filter((row) => !this.state.held.has(row.id) && !this.state.deleted.has(row.id));
    // One claim transaction for them all; another process's runs are skipped (`record` refuses).
    this.state.claimFamilies(stored.map(rowFamily));
    for (const row of stored) {
      const run = this.state.record(row.id);
      if (run) candidates.push(run);
    }
    for (const run of candidates) {
      const unread = UNREAD_RUN_RULE.matches(run);
      if (!unread) continue;
      if (automation !== undefined && (automationIdOf(run) !== undefined) !== automation) continue;
      const before = snapshotRun(run);
      run.seenAt = now;
      this.state.touch(run, before);
      count++;
    }
    return count;
  }
}
