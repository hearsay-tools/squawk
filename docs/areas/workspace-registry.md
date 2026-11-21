# Workspace registry and per-user state

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/paths.ts`, then `packages/cezar/src/workspace/config.ts`, `packages/cezar/src/workspace/projects.ts`, `packages/cezar/src/workspace/migrations.ts`, `packages/cezar/src/workspace/semaphore.ts`

## Project-directory reads before P5

Project registry roots do not change. Managed-worktree recognition accepts both
`.ai/cezar/worktrees/` and `.ai/squawk/worktrees/`; Git discovery still determines
the project root. Project contexts and cold searches use the ordered resolver.
This does not change the home layout or enable project migration.

## Rules

`<config>/config.json` is the per-user workspace config **and** the project registry — every repo Squawk has been booted in (spec `2026-07-20-multi-project-workspace`). Entry points resolve a `Home` once and pass it through the migrated path mechanisms ([ADR 0059](../adr/0059-resolve-home-at-entry-points.md)). `home/resolve.ts` owns cockpit path formulas, with the [platform roots](../migration.md#home-directories) and explicit legacy source. Runtime config, accounts, model policy, launch, delegation, webhooks and project contexts also receive that object. Library APIs require an explicit Home or a path derived from it. The compatibility shim and ambient library defaults are removed in P1a-2 (hearsay-tools/cezarion#2810). `HSQ_HOME` (`CEZ_HOME` fallback) keeps registry and install writes in tests and containers off a real home in the split layout. The legacy layout, which a server-migration rollback can also select, reads only `CEZ_HOME` (or `~/.cezar`). In the split layout `CEZ_HOME` (or `~/.cezar`) is also the migration source: with only `HSQ_HOME` set, split-layout boot or `hsq migrate` copies the real `~/.cezar` registry into the new home and writes `MOVED.json` in the real home. For an isolated home, set `CEZ_HOME` to the same sandbox as `HSQ_HOME`; for an intended migration, point `CEZ_HOME` at the legacy home to migrate from. Schema rules are load-bearing: every field optional with `.catch`, `.passthrough()` at every object level, per-entry salvage for `projects` (one bad row never evicts the registry), and writes only through `mergeWriteWorkspaceConfig` (read-modify-write + atomic tmp/rename, `0600`) so two processes converge. A corrupt or read-only home degrades to in-memory defaults with ONE warning — never a boot failure. Migrations are config-files-only, idempotent, additive and non-blocking; run state never migrates. `maxParallel`/`memoryLimitMb` are workspace-wide (`resources`): the per-repo keys are imported once by migration 001 and ignored by enforcement afterward. Registration is suppressed for task worktrees and `$HOME` itself (`shouldRegisterProject`). A merge-write resolves its path ONCE and uses it for both halves — resolving it twice let a `HSQ_HOME` (`CEZ_HOME` fallback) that changed mid-flight read one home and write another, wiping the user's registry. Two guards back that up: `assertSquawkHomeWriteIsSandboxed` refuses any write into the real `~/.cezar` from Vitest, node:test, Jest or Stryker, using the OS account home even when HOME is pinned, and `packages/cezar/vitest.setup.ts` and the node:test preload `scripts/test-home-env.mjs` pin `HSQ_HOME` (`CEZ_HOME` fallback) to a per-worker sandbox so no case ever runs unpinned. Every write that leaves projects behind also snapshots `config.json.bak`, which `loadWorkspaceConfig` restores from when the config is missing, empty or corrupt (a config that parses and is simply empty is the user's own state and is never overridden).

**Agent accounts** (spec `2026-07-29-agent-profiles`) live in this directory too, but in their OWN file — `<config>/agent-accounts.json`, never a key in `config.json`, so a Squawk that has never heard of accounts cannot drop them; `src/workspace/agent-accounts.ts` owns the store, `src/core/agent-profiles.ts` the vendor knowledge and `src/workspace/agent-profiles.ts` the resolution. Browser sign-in uses `settingsAdmin`, including host-granted hosted cockpits; account creation, editing and listing still use `localHandoff` (ADR 0055).

Every changed HomeStore file is backed up before replacement or removal under
`Home.backups/<home-relative file>/<UTC>-<sha8>.json`, including remote grants
and server instances. Install locks (`*.install.lock`) get no new snapshot: a
lock holds only the pid of a running installer, so its snapshots held nothing to
recover and grew with every install run. Snapshots that older versions wrote
stay listed and restorable. Private snapshots keep the last 20 plus
one per day for 30 days. Backup failures warn once per file and never block the
primary write. HomeStore checks the backup directory chain before the write lock;
unavailable, dangling or escaping paths disable both backup creation and pruning.
`hsq backup list [<file>]` reads legacy backups without migration when the split
home has no install marker. Once the split home has a marker,
it reads that home. Listing never prepares either home. The legacy fallback reads
only paths inside the legacy home: a link that leaves it is not listed. It discovers every
supported file, including backups whose
live file is gone. Legacy root-file snapshots and nested named-instance snapshots
remain readable. `config.json.bak` is listed as the newest config backup; the
loader still restores it only when the primary is missing, blank or corrupt.
`hsq backup restore <file> [--at <time>]` uses the same recovery writer as the
cockpit. The default restores a pinned recovery target when one exists; an explicit
UTC time selects a retained snapshot. Restoring config/accounts keeps tolerant
schema parsing. Other home files, including locks, restore their exact bytes.
Account config directories are not restored. The `.bak` snapshot and its journal
stay auxiliary: a failure warns and leaves the primary save committed.

### Explicit home paths

Library readers and writers require the caller's `Home` or a path derived from it.
CLI dispatch resolves it once at the operator entry point; task subcommands do not
resolve or receive one. OS-user paths, such as a user-authored tilde skill source,
keep their separate meaning. `cez/home-boundary` enforces this boundary and checks
the shrink-only OS-user reader list (hearsay-tools/cezarion#2810).

Tests select `Home.sandbox(dir)` and use the shared setup's selector for process
entry tests. The factory contains cache and config paths under that directory and
creates a test `install.json` marker without replacing an existing one. A request for
a test marker refuses the account's real Squawk home in every process, with or without
a test-runner variable: the legacy home, each platform default root, their descendants
and symlink aliases (`home/protected-roots.ts`, hearsay-tools/cezarion#2778). On
Windows and macOS the comparison ignores case, so an absent `.CEZAR` still counts as
`.cezar`. An empty or relative OS account home fails closed. The
refusal runs before an existing marker is returned. `scripts/test-install-marker.mjs`
imports no product module, so it keeps a local copy of the check;
`home/test-marker-guard.test.ts` holds its roots equal to the product's. Seed fixtures
with `Home.seed` or `Home.seedBytes`; both use HomeStore. A direct file write belongs
only in a test that deliberately simulates an outside writer.

### HomeStore

`home/store.ts` owns registry file reads and writes, including `config.json.bak`,
remote grants, server instance state and install locks. Existing tolerant readers
keep their schema and error behavior. Merge writers hold one short per-root lock
across the read, mutation and replacement. The lock lives in `<home>/.locks/write.lock/`.
It uses unique process claims; stale claims use the process identity checks in
`core/process-stat.ts`. Serving cockpits hold independent
`<home>/.locks/cockpits/<pid>.lease` files. A lease does not block a CLI writer.
Mutual exclusion requires one PID namespace; cross-container bind-mounted homes
are a stated limit. An unconfirmed process claim expires after 30 seconds to recover
from PID reuse. A confirmed live process token never expires. See ADR 0060 for
the long-running-holder trade-off and cross-namespace lease collisions.

Serve, init, run and backup restore prepare an install marker unconditionally,
after their arguments validate: `run` without a task, and `backup restore` with
help, an unsupported file, extra arguments or an invalid `--at`, prepare nothing.
Other authorized operator entries prepare existing registry files at entry. On an
empty home, they record authorization in process memory and create nothing until
the first write. That write creates the marker and seeds HEAD under the same lock.
Help, invalid commands and pure reads leave an empty home untouched. Managed-layout
writes consume their entry authorization after validation too. Library writes
without entry authorization still require a marker. The marker check uses the actual process to refuse
a `live` home under Vitest, node:test, Jest or Stryker. An env argument cannot bypass
it. The passwd-home guard remains a separate check. Read-only homes stay readable,
even when their auxiliary lock or version directory cannot be written.

The first entry seeds each existing registry file's committed version without
changing its bytes or mode. Marker publication and seeding hold one write lock.
Each file seeds best effort; an unreadable file cannot stop other files or an
unrelated primary save. Every entry and the first authorized transaction retry
missing HEAD records even when the marker exists. Each later write stores content by hash, writes `PENDING`,
replaces the live file, advances `HEAD`, then clears `PENDING`. A read finishes an
interrupted commit or records an outside write and pins its original restore target.
Outside-write enforcement is **on** in P1c (hearsay-tools/cezarion#2812). All
HomeStore mutations, including exclusive lock creation, refuse a flagged file until
an explicit restore or acceptance. The pinned target cannot absorb later writes.
Emptying nonempty projects or accounts records a durable reset flag with the prior
version. Recovery demand also detects an empty registry whose newest backup has
projects. Acceptance records the current hash, so an accepted empty registry does
not raise the same banner again.

`GET /api/v1/home/recovery` exposes file names, reasons, times and restore availability;
it never exposes file contents. Metadata and content fingerprints avoid repeated
HomeStore transactions for unchanged files, including on coarse-timestamp filesystems.
The trusted-only `home:recovery` topic uses
filesystem watches only while subscribed, including journal directories so another
cockpit's acceptance clears the banner. Restore and accept POST routes use the
normal origin guard, `localHandoff`, and the contract's HomeStore file allowlist.
Remote grant files remain host-CLI-only. Remote banner rows are read-only. Actions
carry the incident time; resolved retries do nothing, while a different incident
returns a conflict. See ADR 0060 for
write ordering and the remaining version-retention and staging-file limits.

## Split home roots

ADR 0059 defines `Home.config`, `state`, `data`, `cache` and `runtime`.
`root` remains the config root. `resolveHome({ purpose, env?, layout?, platform? })`
selects split by default; migration code asks for `layout: 'legacy'` to read the old home.
Tests can select either layout explicitly. `Home.sandbox(dir, { layout: 'split' })`
creates a test marker under `<dir>/config` and keeps every kind under dir.

In split layout, registry, accounts and remote settings use config. UI state,
server files and locks and backups use state. Managed
versions and bin use data. Skills use cache. Runtime has no file
consumer yet. Legacy paths and managed launcher fixtures remain unchanged.
`home/file-location.ts` exports the single `homeFileKind(key)` map and
`homeFileLocation(home, key)` for unchanged HomeFile keys. Config, its `.bak`,
accounts and remote grants use config. UI state, server state, named instances
and install locks use state. HomeStore uses the owning root for `write.lock`
and `.versions/<key>/`; readers of state paths pass their Home explicitly.
The marker check always reads `<config>/install.json`; presence leases stay in
`<config>/.locks/cockpits/`. Backups of both kinds use `<state>/backups/<key>/`.
Recovery scans live families and journals in both roots, including deleted files,
and watches both roots and their journal families only while subscribed.
Entry seeding holds the config lock through marker publication and seeds each
file under its owning lock. Transactions that need both roots take config first.
Legacy roots coincide, so their paths and existing recovery formats stay intact.

`HSQ_HOME` (`CEZ_HOME` fallback) selects one-root subdirectories. An explicit
`CEZ_HOME` equal to the legacy default counts as unset in split layout. An
explicit `HSQ_HOME` still selects its own one-root layout. Both names belong to
`HOME_LOCATING_ENV` and are always removed from child environments. The separate
`HOME_LAYOUT_ENV` list contains platform layout values, which still reach agents.
The resolver has no filesystem access. New roots and the Windows current-user
private ACL apply to the split layout.

## Legacy migration

`home/migrate.ts` exports synchronous `migrateLegacyHome(legacy, target,
{ commit = true, env?, onStep? })`. Entry points call it; tests inject a split Home. It returns
`{ status: 'fresh' | 'migrated' | 'unchanged' | 'pending', record? }`.
`home/migration-plan.ts` exports the shared read-only `planLegacyMigration`
used by `hsq migrate --dry-run`.

The legacy `.migrating` claim contains `{ pid, startToken? }`, uses exclusive
creation, and reclaims proven-dead holders under the legacy write lock.
Steps 2–8 run synchronously under that lock, then target config and state
locks, without extending the short-lock protocol. HomeStore checks for the
claim before waiting and inside its transaction. This one safety change is
unconditional; ordinary reads do not probe `.migrating`.
Boot refuses live migration holders and lets migration reclaim dead holders,
including a pending copy left by a hard crash. Only a finished
`commit: false` copy is a staged server group: its record has `stagedAt` and
boot serves it read-only. A pending home without `stagedAt` is a failed or
crashed run, and boot restarts it at step 4. Step 5's recovery refusal runs
before the first target write, so a refused run leaves no pending home.
Recovery inspections recheck the claim and pending marker under their lock.
They then run the normal journal interpretation on a report-only VersionLog,
which keeps every record change in memory: a reset interrupted after its
replacement (PENDING, stale HEAD) still reports, and no journal file changes.

An absent legacy home leaves conditional entries read-only. Their first write
commits the fresh decision before the registry mutation; serve, init, run and
backup restore commit it at entry. Help, invalid commands and pure reads create
no home. The deferred preparation runs once per entry, before the first write. When
it selects another home (a legacy server install appeared, a rolled-back group or a
staged group), the write fails with `Run hsq server-migrate.` and the split home stays
unwritten; each later write fails the same way. An existing empty legacy home keeps
its migration decision at entry.
A fresh decision returns `fresh` and commits an explicit
decision: a v1 record with `files: []` and `backup: ''`, then the marker with
`migratedFrom` and `state: 'committed'`. A fresh home therefore carries
`migratedFrom` and `committed` too. `MOVED.json` is written only when the
legacy directory exists; a new install never creates `~/.cezar`. A later
older-binary write to the legacy home then never re-runs migration: step 3
returns `unchanged`, and P2b-2 treats a legacy file absent from `files` as a
legacy change. The fresh branch refuses while the target holds a pending or
rolled-back copy (`install.json.failed`): that copy may be the only one left,
so its record and backup reference stay for recovery.

`installMarkerSchema.state` is `pending | committed | undefined`.
`writeMigrationMarker` is the migration's only marker writer; ordinary marker
creation never overwrites one. A pending home refuses HomeStore writes and
permits reads and cockpit leases. Boot detects `install.json.state ===
'pending'` with a staged record and skips migration and seeding so P2c can
check the group read-only.
`prepareHomeLifecycle(home, instance?)` passes the instance into its lease.
With no instance given, the lease names the server record
whose `primaryPort` the cockpit listens on (`serverInstanceForPort`), else
`default`.

For P2c, `migrateLegacyHome(..., { commit: false })` leaves a pending copy.
`commitLegacyMigration(target, env?)` rechecks the legacy hashes, commits the
marker and writes `MOVED.json`. It refuses a target without an install marker,
rolled back or removed, so a discarded copy is never committed. After the marker commits, a retry only finishes
publication and PATH updates; later legacy changes belong to the canary.
Profile symlinks stay intact; a profile inside the legacy home stays unchanged
with a warning. `rollbackLegacyMigration(target)` renames a
pending marker to `install.json.failed`; the next explicit migration discards the
pending copy first: the recorded destinations, the managed install, its launcher
files in `bin/` and the account trees. Other `bin/` entries, markers, locks and
backup archives stay, also when XDG roots share or nest directories. Rollback never rewrites legacy registry data.

Boot defers a server home that supports group migration: only `hsq server-migrate`
stops the group, stages the home and rolls every instance back on failure. The
signal is an `installed` record without `dryRun` in the legacy `server.json` or
`server-instances/` and no committed target marker. Then every CLI entry and the
cockpit boot keep the legacy home, write nothing to the target and warn once on
stderr to run `hsq server-migrate` (the warning says "retry" when the target has
`install.json.failed` from a group rollback). `hsq migrate` still migrates such a
home when the operator runs it. The selected
legacy Home passes through CLI boot and the server lifecycle, including leases;
the second preparation never tries to migrate that legacy Home into itself.
The lifecycle refuses startup if preparation selects a different Home from the
one the caller supplied. Its error names both roots. `startServer` runs this
check before constructing home consumers, so an embedded caller must pass the
Home returned by `prepareOperatorHome`, as CLI boot does.

| Boot state | Selected home and action |
| --- | --- |
| Completed group-migration server, no committed marker | Legacy home; no target writes; warn to run `hsq server-migrate` |
| Completed group-migration server, failed marker, no committed marker | Legacy home; no target writes; warn to retry `hsq server-migrate` |
| Finished staged retry, including a prior failed marker | Pending target, read-only, for the group's health checks |
| Committed target, including a prior failed marker | Target; normal boot |
| Committed target whose recorded source differs from the env's legacy home (a launch with only `HSQ_HOME`) | Target; the recorded source stays the legacy home and canary |
| Local home with no server install, incomplete install or dry-run server, with or without a failed marker | Existing boot migration to the target |
| Boot migration fails with `EROFS`, `EACCES` or `EPERM` before the commit | Legacy home; one warning; the next boot retries |
| A step after the commit fails with `EROFS`, `EACCES` or `EPERM` | Target; one warning |

The shared capability check requires migrate, rollback, stop and start methods. Both
`ubuntu-vps` and `macosx-ngrok` (hearsay-tools/cezarion#3234) pass it, so a home that records
either install migrates only through `hsq server-migrate`. A platform without these methods
would keep the local boot migration. The macOS path is checked by unit tests with a fake `launchctl` only, not on a real Mac.

An explicit `hsq migrate` or successful `hsq server-migrate` recopies the current
legacy data and commits the target, which clears the boot skip. The failed marker
stays as diagnostic evidence. `migrate --dry-run` and legacy recovery actions do
not commit a target or clear the skip. No new state marker or setting is used.

`hsq server-migrate` (`server-install/group-migrate.ts`) is that caller. It holds every instance's install lock in the
records home, sorted, for the whole run. `--dry-run` only reads: it takes no
install lock, does not prepare the legacy home and writes no file. Server records
are read as plain bytes, so a missing version log is not seeded by planning. Its plan
names the stop of every instance, each unit, site, file and environment move
(one line each), each instance's health check, the group, the pending marker
and the rollback. Before the first platform move it
writes `<state>/server-migrate.json` (version 1: `phase`, `stagedHome`, and per
instance the dry-run `planned` report and the returned `moved` report). The
home commits after every health check passes and before the journal says
`committing`, so a commit refusal (a legacy file changed during the checks)
rolls the whole group back. Like
`migration.json`, it is a migration-owned private write that a pending home
permits. A `migrating` or `rolling-back` journal is recovered by rolling back
every planned move from disk state, then the pending home. A `committing`
journal, or a `migrating` one over a home it staged and whose marker
committed, finishes the commit, then applies each `moved` report to the copied
server records. The journal is removed when the group commits or rolls back
completely. A failed compensation keeps it and the pending home for the next
run.

`home/migration-record.ts` owns `migrationRecordSchema` (version 1) and the
private `readMigrationRecord(home)` / `writeMigrationRecord(home, record)` pair.
Writers hold config then state locks. A record contains `legacyRoot`, all five
`roots`, `createdAt`, `backup`, `files`, `deferredAccounts`, `notMoved`, and
the optional `stagedAt`.
Each file has its legacy-relative `path`, SHA-256 `hash`, `mtimeMs`, and a
nullable `target: { kind: config | state | data, path }`. Unmapped legacy files
are observed but not imported. `movedHomeSchema` is
`{ version: 1, roots, migratedAt }`.

Step 7 uses VersionLog under the migration locks to rewrite target account
paths while pending. It preserves the legacy bytes and publishes HEAD; it
does not add a HomeStore bypass. Deferred accounts finish at a later boot
through ordinary HomeStore writes once no live run registered in either the
target or the legacy registry can use them.
The read-only run-store probe uses live run rows and a live family owner's PID
and start token. It defers unknown selections or unreadable stores too; dry-run
lists the same deferrals. A non-cockpit owner can keep a closed session's account
deferred until its claim ends. Live legacy cockpit leases already stop step 2.
An internal omp account stays in place and records `notMoved` with reason
`omp-profile-root-inside-legacy-home`; the warning asks to move `PI_CONFIG_DIR`
outside the legacy home (planner decision for hearsay-tools/cezarion#2933).
Account inventory reads accounts through the loader's own source,
`readAgentAccountSource`: `agent-accounts.json` with the loader's salvage
(a non-array `accounts` names no account), or, when that file is absent, the
one-time `config.json` `agentProfiles` import. An imported account relocates
like a stored one; the rewrite publishes the store that import would persist.
Account inventory uses the loader's first-wins ID rule. Later duplicate IDs
stay in place and record `notMoved` with reason `duplicate-account-id`.
Each pending account or managed tree is rebuilt in a fresh staging directory.
Every accounts pass rebuilds all targets derived from the account sources: it
drops account trees the pass no longer copies, and it rebuilds the target
`agent-accounts.json` from the legacy source. A step-6 recopy of
`agent-accounts.json` or `config.json` therefore never leaves stale accounts.
Deferred retries first check the target registry: an already rewritten
configDir repairs the migration record without copying over live credentials.

`isSquawkMigrationJson` defines the strict JSON set. It covers Squawk's live registry,
state, grants, connections and update JSON. Historical backups and version
snapshots are opaque bytes, even when their filenames end in `.json`.
An exact legacy `ACCEPTED` journal record follows its copied registry bytes;
other journal records do not migrate. A recopy drops acceptance if its hash
no longer matches, so an unrelated later state cannot inherit it.
Opaque vendor account
trees and managed `versions/` are verified byte for byte, since their `.json`
files can be JSONC. Copies, archives, records and journals use private files
and split-layout Windows ACLs. Every tree copy keeps the owner-execute bit:
a file is 0700 when its owner could execute the source (managed executables,
launchers, account profile hooks) and 0600 otherwise. The old launchers remain
unchanged. Archive entries record the same 0700 or 0600 mode. Launchers come from `writeLaunchers`, and the PATH line update
replaces the line `pathHook` defines, which the removed `hsq install` wrote.
The managed package link at `versions/<id>/node_modules/@wjarka/cezarion`
keeps an external checkout only when its version manifest records that same
checkout with `source: 'link'`. Other escaping links refuse migration.
A dangling link is copied as written when its lexical target stays inside
the source tree, and refuses migration otherwise.
Staged tree copies compute link targets against the final destination;
absolute links and Windows junctions never retain staging paths.
The archive writes one gzip member per tar entry, followed by tar end blocks.
This standard concatenated gzip stream bounds buffers by the largest file,
while retaining legacy journal history and backups in the archive.

## Legacy home canary

The canary shares the recovery snapshot, journal and demand-owned watchers. It runs
only with a committed marker with `migratedFrom`.
`migration.json` supplies the hash baseline; FRESH decisions also discover later
registry files. Each changed HomeFile with a non-null target gets one legacy row,
after any live-file recovery incident for that file. Opaque trees and observed-only
`target: null` files have no banner row in this slice.

Import uses the exact legacy bytes retained under the migration hash in the owning
VersionLog as its base. It applies top-level legacy key changes and per-ID changes
in `config.json` projects and `agent-accounts.json` accounts; other arrays change as
one value. Live-only changes survive. Legacy wins where both changed the same key
or entry, as the row explains. Missing, unreadable, corrupt or non-object JSON bases
make the row Ignore-only; Import rechecks the base at action time. A recorded absent
file remains a valid empty base for later creations. Unchanged verified retained versions reuse
the JSON check across polls; read failures are retried. Unlike ordinary writes,
Import requires its HomeStore backup to succeed before replacement. A deleted legacy
file offers Ignore only. Import and Ignore retain the exact observed legacy bytes
as the next base, then update the migration hash (null for deletion). Incident times
are pinned in the existing per-file journal's `LEGACY` record, so stale requests
conflict and multiple cockpits see the same incident.

Imported account entries retain completed step-7 relocations into
`<data>/accounts/<id>`. The migration's file mappings (or an empty account's original
entry and created destination) prove relocation; deferred accounts do not. An imported
legacy-internal account without relocation refuses Import and names the account.
Remote sessions see the global banner read-only, with the existing host instruction.

Legacy grant rows remain read-only in every cockpit. The host operator resolves
them with `hsq backup import remote-settings/<id>.json` or `hsq backup ignore
remote-settings/<id>.json`. The banner shows Import only for an importable source
and always names Ignore. These CLI actions use the same recovery writer.

## Multiple projects, one cockpit

One `hsq serve` hosts **every repo you work in**, not just the one you started
it in. Each repo Squawk boots in registers itself in a per-user registry at
`<config>/config.json` — the workspace file that also holds the global knobs
(the parallel cap, the memory ceiling, the browse root, and the checkout root). Nothing is added to
the repo: per-project state stays in that repo's `.ai/squawk/` (or `.ai/cezar/`
until the project moves).

Every view is project-scoped:

```
/p/<projectId>/            tasks · activity · git · github · skills · workflows · reports · settings
```

`<projectId>` is a slug derived from the folder name (`my-app`, then `my-app-2`
on a collision), and `/p/default/…` always means the project Squawk was started
in. The desktop rail selects the project. Its sidebar shows the project header,
view tabs and task list, ordered **Needs you → Finished → Working**.
Pins stay first within their status section and do not spend the default ten-row
budget; Finished takes priority over Working when that budget fills up. Each
section starts expanded and folds independently using its heading (click, Enter
or Space). Folding is remembered per browser, project and section, separately
from folding a project. Folded headings keep full task counts and attention
indicators, including tasks outside the visible row limit. These controls work
in the mobile drawer too. **Archive all** appears only on Finished and archives
all eligible unpinned tasks, including hidden rows; individual archive actions
and Undo remain available. Archived keeps its existing history view.
The view tabs are Tasks, Activity, GitHub, Skills and Settings. More views holds Git,
Workflows and Reports, and Automations when enabled. The project menu
offers Mark all read and project settings; local mode also offers Open in and
Copy path. Active/Archived remains below the Tasks heading. The new-task
composer names the project it will run in.

**Adding a project** — the **+** button on the desktop rail (or in the mobile
navigation drawer):

- ✨ **New project…** creates a git repository with one empty commit in the checkout
  root and registers it. Optionally — only when you switch it on — it also creates a
  **private** GitHub repository under your account or one of your organizations, empty or
  from a GitHub template. If GitHub setup fails after the repository exists, the local
  project is kept and the dialog shows the command that finishes it. A hosted cockpit
  creates local projects only.
- 📂 **Open local folder…** browses from the configured browse root
  (**Settings → Projects**, default `~/`) in a folder picker and
  registers the folder you pick.
- ⬇️ **Clone from GitHub…** clones with your logged-in `gh` into the checkout
  root (**Settings → Projects**, default `~/cezar/projects`) with live progress,
  then registers the clone. Close the dialog and the clone is killed and its
  partial directory removed. For a SAML-protected organization, follow **Authorize
  this GitHub organization**, authorize in GitHub, then return to retry once (or
  choose **Retry clone**). Original errors remain available under **Error details**.
  Clones use HTTPS and save the GitHub CLI credential helper in the new repository
  so later pushes use the same organization grant, even if `gh` prefers SSH.

Removing a project (**Settings → Projects**) drops the registry entry only — the
repo and its `.ai/cezar/` are never touched, so re-adding it later finds all its
tasks intact. The project Squawk is currently serving can't be removed: it
re-registers itself at the next start.

**From the terminal** — the same registry, no cockpit required (handy over ssh):

```bash
hsq backup list [<file>]           # list rotating config.json / agent-accounts.json backups
hsq backup restore <file> [--at <time>] # restore JSON only; account folders are unchanged
hsq projects                      # list: id, branch or status, path, tags
hsq projects add ~/code/api       # register a folder (defaults to the current repo)
hsq projects remove api           # drop the registry entry; the repo is untouched
hsq projects tag api storefront backend     # set the grouping tags (no tags clears them)
```

These read and write `<config>/config.json` directly, so they work with the
server stopped, and `HSQ_HOME` (`CEZ_HOME` fallback) selects which workspace they operate on.

Settings split along the same line: **General** (the project's folder, its
registry facts, its parallel-task ceiling, and Remove), **Agents**, **Agent config**,
**Worktrees**, **Sidebar** and **Prompt templates** describe one
repo and live under `/p/<projectId>/settings`; **Appearance**,
**Notifications**, **Resources**, **Skills**, **Agent accounts** and **Projects**
are yours or the machine's and live at `/settings/global`.

**Settings → Sidebar** controls this project's task rows on desktop and mobile.
Set **Overall**, **Needs You**, **Finished**, and **Working** to a positive whole
number or **Unlimited**. Defaults are 10 overall and Unlimited for each section.
The overall budget is allocated in section order (Needs You, Finished, Working),
and each section must also fit its own limit. Unlimited removes only its selected
constraint. Pinned rows and groups containing pins bypass both budgets; a grouped
task counts as one row. Archived uses only the overall limit, with no pin exemption.
Save applies the preferences to this project and keeps them after a reload.
Refreshed preferences update an untouched form; unsaved edits stay in place.
Malformed stored sidebar limits fall back field by field to these defaults,
while valid limits and unrelated preferences are preserved.

On desktop, Settings replaces the sidebar task list with two groups: **This project**
and **Global · every project**. Each group includes General and its available sections;
the current section is highlighted, and the main page shows its content. On mobile,
the section picker and General page's section cards provide navigation.

The GitHub sidebar groups **Issues** (Assigned to me, No task yet, Has a task,
All open) and **Pull requests** (Review requested, Mine, Checks failing, All open).
Selecting a filter updates the URL, so reloading keeps that selection. The issue
list, detail pane and Hand to agent action stay in the main area. On mobile, the
GitHub tab opens the filter screen; selecting a row opens its list.

Has a task and No task yet use issue references from this project's non-archived
tasks, excluding references to other repositories. The list loads 50 rows at a time
and loads the next page as you scroll toward its end. The tabs and All open show
GitHub's exact open totals. A preset count shows a `+` while more pages remain
unloaded, and a search count shows one when the search reaches its result limit;
an unavailable count is not shown as zero. Filtering by search, label, assignee or
board narrows the loaded rows; while it is on, the next page loads only when you press
Load more.

The `body` field on `GET /api/v1/github` list rows is deprecated. It is still sent,
and a later minor removes it; read an item's body from the comments route's `detail`. Views without their own navigation still show tasks in the sidebar.

Open an issue to see **Linked tasks (N)** beneath its heading. Each row opens a task
in the current project and shows its title, status and date, newest first. Archived
tasks remain listed with an **Archived** label, so diagnosis and implementation
sessions are both reachable.

The Git sidebar lists **Task worktrees** that still exist on disk, including retained
worktrees from finished tasks. Each row shows its branch, task title, status and
available diff counts, and opens that task's Changes tab. Reclaimed worktrees disappear
from the list. Changes, Commits and Branches remain tabs in the main repository header.
On mobile, Git sits in the More sheet and opens the worktree list; **Open repository** opens the repository
view, and **Back to worktrees** returns to the list.

### Grouping connected repositories: tags and the All tasks page

Work rarely stops at a repo boundary. A storefront is an API, a web app and a
design system; a platform is a handful of services plus the infra that runs
them. **Tags** are how you say so, and **All tasks** is where saying so pays off.

**Tag a repo** in **Settings → Projects**: type into the *Tags* cell on its row
and press Enter (comma works too; the × on a chip, or Backspace in an empty
field, removes one). The field **autocompletes from the tags already used in the
workspace** — click the field to see them all, arrow keys and Enter to pick —
which is what keeps the second repo landing on the first one's spelling instead
of inventing `store-front` next to `storefront`. Anything not on the list is
just typed. A tag is a free-form label — `storefront`, `infra`, `client-acme` —
and a project can carry several, because a repo can belong to more than one
piece of work. Tags are trimmed, deduplicated case-insensitively (`API` and
`api` are one tag) and stored in `<config>/config.json` beside the rest of the
registry, so they are yours and this machine's, never something added to the
repo.

**All tasks** — the layers icon on the desktop rail, `/tasks`, or `⌘K → All tasks` —
then shows every registered project's work in one table:

- **Filter** by tag, status and workflow. Tags are one-click chips; status and
  workflow are searchable multi-selects. Every facet ORs inside itself and ANDs
  across, so *"anything running or waiting in storefront or infra"* is one set
  of clicks. Each option carries how many tasks it would leave, so a filter that
  would empty the table says so before you click it. The search box matches
  title, project, workflow, branch and tags.
- **Group by** tag, project, status or workflow — click the pressed one again to
  ungroup. Grouping by tag is the reason tags exist: three repos tagged
  `storefront` become one section, and a repo tagged twice appears under both —
  it genuinely belongs to both.

The filters, the grouping and the Active/Archived tab live in the **URL**, so a
filtered view survives a refresh, pastes into a chat, and sits in a bookmark —
`/tasks?tag=storefront&status=running&group=tag` is a link to exactly what you
were looking at. Only what you changed shows up: Active is the default, so the
Archived view is `?archived=1` and a normal link carries no key for it.

Each row shows **every** PR and issue it references — a task opened on an issue
that landed a PR shows both — plus its cost and live CPU/memory, and can be
marked **read/unread** (the eye) or **archived** (or restored) right there. Every task title, project name and project group heading links into that
project, so the thread, its diff and its worktree are one click away and stay
exactly where they were. Returning to a long thread restores its saved row measurements
once the replay has rebuilt the same ordered messages, keeping the same content in view.
Scrolling, jumping to the latest message, or loading different history takes ownership
from that restoration; a thread left at its live tail follows the current tail.

There is deliberately **no project filter**: narrowing this page to one project
is that project's own Tasks page, which is a better version of the same answer
(live updates, the full column set, the composer). So picking a project *leaves*
for it rather than turning the global view into a worse local one.

Nothing else in Squawk reads tags, on purpose: a tag is a lens, not a permission,
a queue or a routing rule. Removing one changes what you see and nothing else.

> The page reads a workspace-wide index capped at the newest 200 tasks per
> project — it says so, and names the projects it capped, rather than showing a
> short list as if it were complete. Older tasks are always in that project's own
> Tasks page.

**Old page URLs keep working.** Every unprefixed page path — `/`, `/tasks/<id>`,
`/settings` — still answers, bound to the project Squawk was started in; the
cockpit redirects flat paths to their `/p/<boot>/…` twin, so existing bookmarks
need no change. The HTTP API is the exception: it moved to
`/api/v1/…` (see the CHANGELOG), so a script that calls it needs the extra
segment.

> **Hosted cockpit?** The folder picker is confined to the independent browse
> root. Set `HSQ_BROWSE_ROOT` (`CEZ_BROWSE_ROOT` fallback) narrowly before first boot (or save it in
> **Settings → Projects**) when a remote viewer should not enumerate the host's
> whole home. Clones continue to use the separate checkout root.

---
