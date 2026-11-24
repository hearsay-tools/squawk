import { guardedJsonSql } from './guarded-json-sql.ts';

/** `PRAGMA user_version` of a database this build created. A higher number means a newer Squawk
 *  wrote it; that is refused rather than read, because a newer schema may store what this one
 *  would silently drop on its next write. */
export const RUN_DATABASE_SCHEMA_VERSION = 16;

/**
 * The oldest `user_version` the READ-ONLY reader can read as it stands (`openReadOnly`). It never
 * migrates, so a project this build has not opened yet is still at the version an earlier build
 * left; while every migration since only adds what readers can do without (indexes), that
 * database stays readable rather than reading as empty. Raise it with any migration that changes
 * the names or types of columns a reader queries. Physical column order (schema 15)
 * does not affect named reads.
 */
export const RUN_DATABASE_READABLE_FROM = 1;

/** A format guard for new wait enum values; no table or row rewrite. */
export const MERGE_WAIT_MIGRATION = `
  -- Schema 11 changes no table: PR waits can carry until 'merge_or_blocked' and outcome 'blocked'
  -- (hearsay-tools/cezarion#2712). Older readers cannot parse these enum values and must refuse
  -- the store rather than recover a run without its accepted wait. Upgrade again to recover.
  `;

/** Recompute `worktree_path` for the rows `materializedWorktreePath` (run-row.ts) now leaves out. */
export const DESTROYED_WORKTREE_MIGRATION = `
  -- Schema 12 changes no table: worktree_path is NULL for a worker whose destroy is complete, as
  -- for a reclaimed run, because the destroy removed the directory. Worktree retention lists the
  -- worktree_path rows on every pass and decoded each destroyed worker to drop it. This clears the
  -- rows older builds wrote. The record in data is unchanged, so a row read by a schema-11 build
  -- answers the same; the bump follows the rule that every entry raises the version. A row whose
  -- data is not JSON keeps its column: the store skips that row, and the migration must not fail.
  UPDATE runs SET worktree_path = NULL
    WHERE worktree_path IS NOT NULL AND parent_run_id IS NOT NULL
      AND ${guardedJsonSql("json_extract(data, '$.delegation.destroy.phase') = 'complete'", 0, ['data'])};
  `;
