/**
 * What `RunStore.open` does besides building the store (hearsay-tools/squawk#4042): the pauses
 * between busy open attempts, the one-time import of a legacy `runs.json`, and the SQL that picks
 * the rows open repairs. `open` and `openOnce` stay on `RunStore` as its constructors.
 */
import { join } from 'node:path';
import { guardedJsonSql } from './guarded-json-sql.ts';
import { assertNoLegacyCockpit, assertNoLegacyWriter, backUpLegacyIndex, LEGACY_INDEX_FILE, readLegacyIndex } from './legacy-index.ts';
import { legacyIndexRows } from './legacy-run-rows.ts';
import { RUNS_IMPORT_COMPLETE_KEY, type RunDatabase } from './run-database.ts';

/** The store's record parser; passed in so this module takes no value from `store.ts`. */
type ParseRunRecords = typeof import('./store.ts').parseRunRecords;

/** The pauses between open attempts while the database is busy, when `open` may wait (a boot):
 *  about 3.5 s in all, with each attempt's own busy timeout. Long enough for another process to
 *  finish importing a large `runs.json`. */
export const OPEN_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600];

/** Block this thread for `ms`. Only `open` does, at boot, when there is nothing else to run. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Test seam (#779): `beforeTransaction` runs once `runs.json` is read and parsed, before the
 *  import asks for the write lock; `beforeCommit` runs inside the import transaction, after every
 *  row is written and before the last check that no older Squawk wrote `runs.json` meanwhile. */
let legacyImportHook: { beforeTransaction?: () => void; beforeCommit?: () => void } | undefined;

export function __setLegacyImportHookForTests(hook?: { beforeTransaction?: () => void; beforeCommit?: () => void }): void {
  legacyImportHook = hook;
}

/**
 * Import legacy rows and the completion marker atomically, once. Recheck live-writer evidence
 * before commit and preserve exact input bytes in a synced backup. Leave runs.json untouched;
 * invalid entries are skipped and reported.
 */
export function importLegacyIndex(db: RunDatabase, dataDir: string, parseRunRecords: ParseRunRecords): void {
  assertNoLegacyCockpit(dataDir);
  const snapshot = readLegacyIndex(join(dataDir, LEGACY_INDEX_FILE));
  const parsed = snapshot ? legacyIndexRows(snapshot.bytes, parseRunRecords) : undefined;
  const rows = parsed?.rows ?? [];
  const skipped = parsed?.skipped ?? 0;
  const source = !snapshot ? 'none' : parsed ? LEGACY_INDEX_FILE : `${LEGACY_INDEX_FILE} (unparseable)`;
  assertNoLegacyWriter(dataDir, snapshot);
  legacyImportHook?.beforeTransaction?.();
  let backup: string | undefined;
  const commit = db.transaction({
    upserts: rows,
    deletes: [],
    onlyIfMetaAbsent: RUNS_IMPORT_COMPLETE_KEY,
    beforeCommit: () => {
      legacyImportHook?.beforeCommit?.();
      assertNoLegacyWriter(dataDir, snapshot);
      backup = snapshot ? backUpLegacyIndex(dataDir, snapshot) : undefined;
      const read = snapshot ? { bytes: snapshot.bytes.length, sha256: snapshot.sha256, backup } : {};
      return { [RUNS_IMPORT_COMPLETE_KEY]: JSON.stringify({ at: new Date().toISOString(), source, records: rows.length, ...(skipped > 0 ? { skipped } : {}), ...read }) };
    },
  });
  // Told once, by the import that committed: the marker means no later open reads runs.json again.
  if (commit.skipped || backup === undefined) return;
  const kept = `Its exact bytes are kept in ${join(dataDir, backup)}; https://github.com/hearsay-tools/squawk/blob/main/docs/run-history-recovery.md says how to import it after a repair.`;
  if (!parsed) console.warn(`[hsq] ${LEGACY_INDEX_FILE} could not be read; no run was imported, and this project starts with an empty history. ${kept}`);
  else if (skipped > 0) console.warn(`[hsq] ${skipped} of ${parsed.total} runs in ${LEGACY_INDEX_FILE} could not be read and were not imported. ${kept}`);
}

/**
 * Finished rows whose stored summary an open-time normalization would still change: a referenced
 * PR an older Squawk's created-PR declaration erased, or issue attribution displaced by a
 * follow-up declaration (see `reconcileLoadedRun`), or a summary that is not JSON. Not live, so not
 * in the `live` column; open decodes these few and keeps the ones it actually repaired.
 */
export const LEGACY_REFERENCE_HEAL_SQL = guardedJsonSql(
  "(json_extract(summary, '$.markerRefs.pr') IS NOT NULL AND json_extract(summary, '$.referencedPullRequestUrl') IS NULL AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'pr-reference-heal:' || runs.id AND value = CAST(runs.revision AS TEXT)))" +
  " OR (NOT EXISTS (SELECT 1 FROM meta WHERE key = 'issue-attribution:' || runs.id AND value = CAST(runs.revision AS TEXT)) AND json_extract(summary, '$.markerRefs.issue') IS NOT NULL)", 1);

/**
 * The rows whose stored summary reading their record can change, as SQL over `runs`: the rows
 * `open` decodes to normalize (the `live` column it loads by, then `LEGACY_REFERENCE_HEAL_SQL`).
 * With a repository handle, a row whose summary `namesForeignReference` is one too, as
 * `setRepoHandle` reads it. The cold reader (run-index.ts) decodes exactly these rows and serves
 * every other stored summary, so the two read paths cannot disagree about which rows to read.
 * `AUTOMATION_ORIGIN_HEAL_SQL` is left out on purpose: no cross-project view reads
 * `automationId`, and asking it scans `data`.
 */
export const LOAD_REPAIR_SQL = `live = 1 OR ${LEGACY_REFERENCE_HEAL_SQL}`;

/**
 * Rows whose record names the automation that launched it while the stored summary does not
 * (hearsay-tools/cezarion#1332): summaries a Squawk wrote before `RunSummary.automationId`
 * existed. Open rewrites each one's summary once, so the sidebar's Automations tab classifies a
 * finished task nobody has opened since the upgrade. `instr` keeps the JSON parse off every
 * other row.
 */
export const AUTOMATION_ORIGIN_HEAL_SQL = `instr(data, '"automation') > 0 AND ${guardedJsonSql("json_extract(summary, '$.automationId') IS NULL" +
  " AND (json_extract(data, '$.automation.automationId') IS NOT NULL OR json_extract(data, '$.automationTrigger.automationId') IS NOT NULL)", 0, ['summary', 'data'])}`;

/** Completion is recorded only after an empty scan, never ahead of a pending repair. */
export const AUTOMATION_ORIGIN_HEAL_COMPLETE_KEY = 'automation-origin-heal-v1';

/** Optional verification cache: a busy or read-only database must not fail boot. */
export function saveHealMeta(db: RunDatabase, meta: Record<string, string>): void {
  if (Object.keys(meta).length === 0) return;
  try { db.transaction({ upserts: [], deletes: [], meta }); } catch { /* Retry verification on the next read. */ }
}

/** A repository identity and row revision both invalidate a scope verification. */
export function repoScopeStamp(handle: { owner: string; name: string }, revision: number): string {
  return `${handle.owner.toLowerCase()}/${handle.name.toLowerCase()}@${revision}`;
}
