import type { ActivityCheckBucket, ActivityPrProgress } from '@open-mercato/cezar-contract';
import { ACTIVITY_CHECK_NAME_MAX, ACTIVITY_CHECKS_MAX } from '@open-mercato/cezar-contract/activity';
import type { CiProgressSource } from '../activity/read-model.ts';
import { clampText } from '../activity/text.ts';
import type { GithubCheck } from './github.ts';
import { stripTerminal } from './text.ts';

const BUCKETS: readonly ActivityCheckBucket[] = ['pass', 'fail', 'pending', 'skipping', 'cancel'];
const byName = (a: GithubCheck, b: GithubCheck) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * The bucket count of one checks read (spec 2026-11-05-live-activity-view, Data): `counts` covers
 * every row; `checks` lists the first `ACTIVITY_CHECKS_MAX` in name order, each name cleaned and
 * clamped, and `truncated` says the list was cut.
 */
export function checkProgress(rows: readonly GithubCheck[]): ActivityPrProgress {
  const counts = Object.fromEntries(BUCKETS.map((bucket) => [bucket, 0])) as ActivityPrProgress['counts'];
  for (const row of rows) counts[row.bucket]++;
  const checks = [...rows].sort(byName).slice(0, ACTIVITY_CHECKS_MAX)
    .map((row) => ({ name: clampText(stripTerminal(row.name), ACTIVITY_CHECK_NAME_MAX), bucket: row.bucket }));
  return { checks, counts, ...(rows.length > checks.length ? { truncated: true as const } : {}) };
}

/**
 * The check progress of the open PR waits a workspace watches, in memory and keyed by wait id
 * (spec 2026-11-05-live-activity-view, CI check progress; D6: never written to a run, empty after
 * a restart). The shared CI resource (`acquireCiResources`) holds one next to its supervisor: the
 * supervisor publishes every checks read and removes the entry when the watch ends; the activity
 * read model reads it.
 */
export class CiProgressRegistry implements CiProgressSource {
  private readonly entries = new Map<string, { progress: ActivityPrProgress }>();
  private readonly listeners = new Set<() => void>();

  /** Call `listener` after a wait's progress changes or its entry is removed. The activity topics
   *  listen while they have subscribers. Returns the release. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** A checks read of an open wait. */
  publish(waitId: string, rows: readonly GithubCheck[]): void {
    const entry = this.entries.get(waitId);
    const progress = checkProgress(rows);
    if (entry && JSON.stringify(entry.progress) === JSON.stringify(progress)) return;
    if (entry) entry.progress = progress;
    else this.entries.set(waitId, { progress });
    this.changed();
  }

  /** The wait resolved or was cancelled. */
  remove(waitId: string): void {
    if (this.entries.delete(waitId)) this.changed();
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  /** The progress of a wait this process watches. */
  read(waitId: string): ActivityPrProgress | undefined {
    return this.entries.get(waitId)?.progress;
  }
}
