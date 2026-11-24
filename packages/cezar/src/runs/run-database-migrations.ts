import { AUTOMATION_RUNS_MIGRATION } from './automation-runs.ts';
import { CONVERSATION_ARCHIVE_MIGRATION } from './conversation-archive.ts';
import { CONVERSATION_MEMBERS_MIGRATION } from './conversation-members.ts';
import { REPORTS_MIGRATION } from './report-rows.ts';
import { DESTROYED_WORKTREE_MIGRATION, MERGE_WAIT_MIGRATION } from './run-database-version.ts';

/**
 * Forward-only migrations: entry `i` takes a database from `user_version` i to i + 1. Never edit
 * a shipped entry; append a new one and raise `RUN_DATABASE_SCHEMA_VERSION`.
 *
 * Changing `isLiveRecord` (run-row.ts) needs an entry that recomputes the `live` column for every
 * row. That predicate is TypeScript over the decoded record, so such an entry cannot be SQL alone.
 */
export const MIGRATIONS: readonly string[] = [
  `
  -- Every column beyond id/data/summary/revision exists for a query the spec names. They are
  -- copies of record fields (or of one predicate over the record), computed by the caller in the
  -- same upsert as data and summary, so a row can never disagree with its own columns.
  CREATE TABLE runs (
    -- Insertion order, the rowid itself: given by a row's first insert (runs.json order on import,
    -- then the order runs are first written) and kept by every upsert. Runs created in the same
    -- millisecond list in this order, as they did when every list was a stable sort of the
    -- in-memory map: recovery and the queue start tied runs in it.
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    -- Newest-first order: GET /run-summaries, /workspace/runs-index, the cold newest-200 read,
    -- and count-based history retention (the runs past the newest N).
    created_at TEXT NOT NULL,
    -- Worktree retention: most recently finished first (falls back to created_at).
    finished_at TEXT,
    -- The mark-all-read and archive-finished sweeps select finished statuses.
    status TEXT NOT NULL,
    -- History retention, mark-all-read and archive-finished skip or select archived runs (0/1).
    archived INTEGER NOT NULL,
    -- isLiveRecord() (run-row.ts): the rows RunStore.open loads into memory and recovers. Every
    -- other row stays here until something reads it. Written with the row, never recomputed
    -- (see the note above MIGRATIONS).
    live INTEGER NOT NULL,
    -- The workers of a parent (delegation.parentRunId): delegation families, archive cascades and
    -- the "every worker" recovery passes, replacing whole-map scans.
    parent_run_id TEXT,
    -- The run an idempotent start already created (#504).
    client_request_id TEXT,
    -- The members of a parallel-variant group (spec 010).
    group_id TEXT,
    -- A materialized worktree directory (the path, unless retention reclaimed it): worktree
    -- retention, the worktrees panel and the owned-worker resource collision check.
    worktree_path TEXT,
    -- The branch the run owns: branch cleanup, git-log attribution and the collision check.
    branch TEXT,
    -- Where that branch forked, which branch cleanup reads with it.
    base_branch TEXT,
    -- The commit that last wrote the row: one database-wide sequence (meta 'commit-seq'), so a
    -- revision is never reused, not even by a row deleted and created again under the same id.
    -- A writer compares it with the revision it last read to tell whether the row changed under it.
    revision INTEGER NOT NULL,
    -- The complete record JSON, opaque here.
    data TEXT NOT NULL,
    -- The record's toRunSummary() JSON, so list routes never decode data.
    summary TEXT NOT NULL
  ) STRICT;
  -- Newest first, ties in insertion order: the order every newest-first read asks for, so SQLite
  -- walks the index instead of sorting the tie groups.
  CREATE INDEX runs_created_at ON runs (created_at DESC, seq);
  CREATE INDEX runs_status ON runs (status);
  -- Partial indexes: each query asks for the rows that HAVE the value, and most rows do not.
  CREATE INDEX runs_live ON runs (live) WHERE live = 1;
  CREATE INDEX runs_parent_run_id ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
  CREATE INDEX runs_client_request_id ON runs (client_request_id) WHERE client_request_id IS NOT NULL;
  CREATE INDEX runs_group_id ON runs (group_id) WHERE group_id IS NOT NULL;
  CREATE INDEX runs_worktree_path ON runs (worktree_path) WHERE worktree_path IS NOT NULL;
  CREATE INDEX runs_branch ON runs (branch) WHERE branch IS NOT NULL;
  -- Private key/value metadata: import completion and the two sequences below.
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;
  -- Cross-process ownership (#779, plan step 3): which RunStore may write a delegation family —
  -- a root and its direct workers, or an ordinary run on its own. Only the holder writes the
  -- family's rows, its NDJSON and its cleanup; everyone else reads them.
  CREATE TABLE run_claims (
    -- The family's root id: parent_run_id for a worker, the run's own id otherwise.
    family TEXT PRIMARY KEY,
    -- The RunStore holding it: a random id per open, so two stores in one process differ.
    session TEXT NOT NULL,
    -- That store's process and the process's start identity, so a reused pid is never taken for
    -- the owner. start_token is NULL only where the platform cannot read one.
    pid INTEGER NOT NULL,
    start_token TEXT,
    -- From meta 'claim-generation', bumped by every acquisition. Every write checks that its
    -- family still carries this store's session and generation.
    generation INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX run_claims_session ON run_claims (session);
  -- Private recovery evidence: a write that found its row changed, created or deleted under it,
  -- or its family's claim gone. Never served; kept for a person to inspect.
  CREATE TABLE run_conflicts (
    seq INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    session TEXT NOT NULL,
    -- changed | created | deleted | claim-lost
    reason TEXT NOT NULL,
    -- The row as the writer last read or wrote it (the original); NULL for a row it created.
    base_revision INTEGER,
    base_data TEXT,
    -- What the writer meant to store; NULL with local_deleted = 1 when it meant to delete it.
    local_data TEXT,
    local_deleted INTEGER NOT NULL,
    -- The row as it stands; NULL when another writer deleted it.
    current_revision INTEGER,
    current_data TEXT
  ) STRICT;
  `,
  `
  -- The run lists' window (#864): every unarchived run, plus the newest archived roots. Without
  -- these, each half scans the whole table — about 30 ms at 20,000 runs, on every list read.
  -- Indexes only: nothing a v1 reader reads changes, which is why RUN_DATABASE_READABLE_FROM stays 1.
  CREATE INDEX runs_unarchived ON runs (created_at DESC, seq) WHERE archived = 0;
  CREATE INDEX runs_archived_roots ON runs (archived, created_at DESC, seq) WHERE parent_run_id IS NULL;
  `,
  `
  CREATE INDEX runs_archive_on_merge ON runs (seq)
    WHERE archived = 0 AND live = 0 AND parent_run_id IS NULL
      AND status IN ('review', 'done', 'failed', 'cancelled');
  `,
  `
  -- Schema 4 changes no table: it changes the record JSON in data (spec 2026-10-17-unified-waits,
  -- hearsay-tools/cezarion#1233). Records carry a wait list (waits, lastWaits) and are no longer
  -- written with ciWait, lastCiWait, lastCiWaitError, monitoringWakeAt, monitoringWakeCapReached
  -- or activity 'monitoring'; this build reads those into the list (upgradeLegacyWaits, legacy-waits.ts).
  -- An older cezar reading a row without ciWait would recover a parked run as a plain waiting
  -- one, and settle an owned worker as successful. The version bump makes it refuse the store as
  -- unsupported-schema instead; the recovery is to run this version again.
  --
  -- No live recompute: every row the new isLiveRecord (run-row.ts) calls live was live under the
  -- old predicate too. An open or resolved wait comes from a ciWait or from activity 'monitoring'
  -- with monitoringWakeAt, and the old predicate called each of those live. Rows it called live
  -- that the new one does not (a settled ciWait, stale monitoring on a finished run) are loaded
  -- once more, and open rewrites them, with their live column, as it upgrades them.
  `,
  `
  -- Schema 5 changes no table either: records may carry a human wait (kind 'human', no deadline)
  -- in waits and lastWaits, and the automaticWakes and waitDeliveryFailures counters
  -- (hearsay-tools/cezarion#1234). A schema-4 build would drop each human wait as unreadable and
  -- recover the run without the question it parked on, so the bump makes it refuse the store as
  -- unsupported-schema instead; the recovery is to run this version again.
  --
  -- No live recompute: isLiveRecord already calls a row with an open wait live, of any kind.
  `,
  `
  -- Schema 6 changes no table either: records may carry worker waits (kind 'worker') in waits and
  -- lastWaits, and a record is no longer written with an agent-registered delegation.wait or
  -- delegation.lastWait (hearsay-tools/cezarion#1235, phase 3a); this build reads those into the
  -- list (upgradeLegacyWaits, legacy-waits.ts). Only the completion gate's wait, the one
  -- delegation.completion.waitId names, stays in delegation.wait until phase 3b. A schema-5 build
  -- would drop each worker entry as unreadable and recover the run without the wait it parked on,
  -- so the bump makes it refuse the store as unsupported-schema instead; the recovery is to run
  -- this version again.
  --
  -- No live recompute: isLiveRecord already calls a row with an open wait live, of any kind, and
  -- every row the old predicate called live through delegation.wait is read up and rewritten by open.
  `,
  `
  -- Schema 7 changes no table: a record no longer carries delegation.wait, delegation.lastWait or
  -- delegation.completion (hearsay-tools/cezarion#1301, phase 3b). Cezar's completion gate wait is a
  -- worker entry in waits (source 'cezar', via 'completion'), and this build reads a stored one up
  -- (upgradeLegacyWaits, legacy-waits.ts). A schema-6 build would read an upgraded completion entry without
  -- its deadline as unreadable and recover the run without the wait it parked on, so the bump makes
  -- it refuse the store as unsupported-schema instead; the recovery is to run this version again.
  --
  -- No live recompute: isLiveRecord already calls a row with an open wait live, of any kind.
  `,
  `
  -- Schema 8 changes no table: a usage-limited run is written waiting with autoResumeAt, no longer
  -- failed with it (hearsay-tools/cezarion#1236, phase 4a), and this build reads an old failed row
  -- with autoResumeAt as waiting (reconcileLoadedRun, store.ts). A schema-7 build would clear the
  -- appointment from a waiting row and show the run as Needs you, so the bump makes it refuse the
  -- store as unsupported-schema instead; the recovery is to run this version again.
  --
  -- No live recompute: isLiveRecord already calls a row with autoResumeAt live, at any status.
  `,
  `
  -- Schema 9 changes no table: records may carry process waits (kind 'process') in waits and
  -- lastWaits (hearsay-tools/cezarion#1446). A schema-8 build has no path that skips an unknown
  -- wait kind, so it would drop the row's wait list and recover the run without the wait it parked
  -- on; the bump makes it refuse the store as unsupported-schema instead; the recovery is to run
  -- this version again.
  --
  -- No live recompute: isLiveRecord already calls a row with an open wait live, of any kind.
  `,
  REPORTS_MIGRATION,
  MERGE_WAIT_MIGRATION, DESTROYED_WORKTREE_MIGRATION, CONVERSATION_MEMBERS_MIGRATION, AUTOMATION_RUNS_MIGRATION,
  `
  -- Schema 15 keeps the named columns and rows unchanged. Reading summary must not walk
  -- the overflow pages of data. Rebuild for existing databases and for fresh migration chains.
  CREATE TABLE runs_v15 (
    seq INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    finished_at TEXT,
    status TEXT NOT NULL,
    archived INTEGER NOT NULL,
    live INTEGER NOT NULL,
    parent_run_id TEXT,
    client_request_id TEXT,
    group_id TEXT,
    worktree_path TEXT,
    branch TEXT,
    base_branch TEXT,
    revision INTEGER NOT NULL,
    summary TEXT NOT NULL,
    data TEXT NOT NULL
  ) STRICT;
  INSERT INTO runs_v15 (seq, id, created_at, finished_at, status, archived, live, parent_run_id,
    client_request_id, group_id, worktree_path, branch, base_branch, revision, summary, data)
  SELECT seq, id, created_at, finished_at, status, archived, live, parent_run_id,
    client_request_id, group_id, worktree_path, branch, base_branch, revision, summary, data FROM runs;
  DROP TABLE runs;
  ALTER TABLE runs_v15 RENAME TO runs;
  CREATE INDEX runs_created_at ON runs (created_at DESC, seq);
  CREATE INDEX runs_status ON runs (status);
  CREATE INDEX runs_live ON runs (live) WHERE live = 1;
  CREATE INDEX runs_parent_run_id ON runs (parent_run_id) WHERE parent_run_id IS NOT NULL;
  CREATE INDEX runs_client_request_id ON runs (client_request_id) WHERE client_request_id IS NOT NULL;
  CREATE INDEX runs_group_id ON runs (group_id) WHERE group_id IS NOT NULL;
  CREATE INDEX runs_worktree_path ON runs (worktree_path) WHERE worktree_path IS NOT NULL;
  CREATE INDEX runs_branch ON runs (branch) WHERE branch IS NOT NULL;
  CREATE INDEX runs_unarchived ON runs (created_at DESC, seq) WHERE archived = 0;
  CREATE INDEX runs_archived_roots ON runs (archived, created_at DESC, seq) WHERE parent_run_id IS NULL;
  CREATE INDEX runs_archive_on_merge ON runs (seq)
    WHERE archived = 0 AND live = 0 AND parent_run_id IS NULL
      AND status IN ('review', 'done', 'failed', 'cancelled');
  `,
  CONVERSATION_ARCHIVE_MIGRATION,
];
