# Run lifecycle and run store ports
Status: active

Step 2 of [the plugin core roadmap](2026-11-18-plugin-core-roadmap.md), epic
hearsay-tools/squawk#4007. Baseline: `main` at `8a331af92`. The owner decided the open points on
2026-11-21 in task 59568fef. The [plan](2026-11-21-run-lifecycle-and-store-ports-plan.md) cuts the
work into slices, one child issue each.

## Goal

A feature follows a run through typed lifecycle events, not through `RunStore`'s emitter. A run's
deletion asks registered slots, not feature code that `runs/` imports. Callers reach the store
through named ports, and the `RunStore` class is at most 1,000 lines. After this step:

- `RunStore` extends no `EventEmitter`, and no file outside `runs/` calls `on` or `off` on a store;
- a test receives the lifecycle events of one run in order and opens no run store;
- the webhook, activity and reports-index tests run against lifecycle events and ports, with no
  real run store;
- `layer-import.baseline.json` holds no entry whose file is under `runs/`;
- no `Pick<RunStore, …>` type remains; each of those callers takes a named port;
- `runs/store.ts` has no entry in `file-length.baseline.json`.

The store stays one store in one SQLite file, and it stays the only writer of status and exit
fields ([ADR 0056](../../docs/adr/0056-let-the-run-store-own-run-exits.md),
[ADR 0064](../../docs/adr/0064-record-run-lifecycle-facts.md)). The lifecycle reports what the store
wrote; it never writes.

## Out of scope

- A second store, another database, or storage as a plugin.
- A hook that changes a run's outcome, other than the three removal slots. Add one when a
  first-party feature needs it.
- Step, turn and wait lifecycle events. No listener needs them today (decision 1). The steps and
  turns stay readable in the `run.event` stream.
- Registries for agent tools, wait kinds, step kinds and CLI commands: roadmap step 3.
- A plugin loader and a stable API promise: roadmap step 4.
- Changes to what the cockpit receives over SSE and WebSocket. The feeds move to the lifecycle and
  send the same payloads at the same moments.
- Changes to the webhook payloads.

## Done when

- **Outcome:** each listener that `RunStore` had subscribes to the lifecycle, each deletion path
  asks the removal slots, each former `Pick<RunStore, …>` caller takes a port, and
  `runs/store.ts` is at most 1,000 lines.
- **Proof:** `npm run lint` passes with no `runs/` entry in `layer-import.baseline.json` and no
  `runs/store.ts` entry in `file-length.baseline.json`; `runs/lifecycle.test.ts` receives one run's
  events in order with no store; the webhook, activity and reports-index tests build no
  `RunStore`; each slice's pull request lists the Squeal selection for its files before and after.
- **Failure:** a deletion of a run whose autosave cleanup is not confirmed is still refused, with
  today's 409 message; a deletion in a process that registered no removal slots throws, and
  deletes nothing.

## Evidence

Measured on `main` at `8a331af92` (2026-11-21). The epic's Agent context comment has the first
inventory. Counts of callers come from text search and are approximate.

| Item | Count |
| --- | --- |
| `runs/store.ts` | 3,381 lines, pinned in `file-length.baseline.json`; the limit is 1,000 |
| `this.emit(` in `runs/store.ts` | 10 sites; events `run`, `deleted`, `event`, `closed` |
| Production listener files | 12 (table below) |
| Test files that call `.on` or `.once` on a store | 42 (51 calls in `*.test.ts`, 24 in `*.testkit.ts`) |
| `Pick<RunStore, …>` sites | 41 in 28 non-test files, two of them under `runs/` (`live-tasks.ts`, `supervised.ts`), plus `Partial<RunStore>` in `runs/retention.ts` |
| `layer-import.baseline.json` | 122 entries; 17 have a file under `runs/` |
| Test files Squeal selects for `runs/store.ts` | about 870 of 2,001 (the epic's count; the selection was `unsynced` at `8a331af92`) |

### What the emitter sends today

| Event | Payload | When |
| --- | --- | --- |
| `run` | the record, and a `CommitSource` (`delegation-checkpoint`, `delegation-destroy-progress`, `live-release`) or nothing | After the commit on committed writes (`commitIndex`). Before the SQLite write on debounced writes (`touch`): the record is already changed in memory. From `handleConflicts` with the other writer's record |
| `deleted` | the run id | After the commit for a delegated run; before the debounced write for a plain run |
| `event` | `{ runId, event }` | After the NDJSON append (`appendEvent`), or with no write (`emitEphemeral`) |
| `closed` | none | In `close()`, before the database closes |

No payload holds the state before the change: `commitIndex` runs `Object.assign` before it emits,
and debounced writes change the held record in place. A load that applies an exit
(`loaded-run-exits.ts`, `settleOrphanedRun`) emits nothing. A listener that throws stops the
listeners after it, and the error reaches the writer after the commit.

### The 12 listener files

| File | Layer | Events | What it derives |
| --- | --- | --- | --- |
| `runs/webhook.ts` | feature:webhooks | `run`, `deleted` | A new run, a status change, a question. Keeps a `seen` map seeded from `listRunSummaries()` |
| `activity/publisher.ts` | feature:activity | `run`, `deleted` | Any change: rebuild the activity view |
| `activity/tool-activity.ts` | feature:activity | `run`, `deleted` | Live or not live, for each run |
| `artifacts/reports-index.ts` | feature:artifacts | `run`, `deleted`, `closed` | Report metadata on any change, and a run that settled. Keeps a `live` set |
| `delegation/worker-cleanup.ts` | feature:workers | `run` | A worker that failed before its first step. A state check on every change: the second `run` emit of `commitWorkerExecutionComplete` changes no status |
| `headless-run.ts` | shell | `event`, `run` | Console output and the final status of `hsq run` |
| `server/run-event-feed.ts` | shell | `event`, `deleted`, `closed` | The SSE feed of one run |
| `server/workspace-run-feed.ts` | shell | `run`, `deleted` | The workspace task feed |
| `server/server.ts` (two feeds) | shell | `run`, `deleted` | One run's record feed and the run list feed |
| `server/project-context.ts` | shell | `deleted` | Releases the preview host of a deleted run |
| `server/provider-auth-runtime.ts` | shell | `event` | Login failures in run events. Appends an event from inside its handler |
| `workflows/run.ts` | core | `run`, `deleted` | Family reconciler, wake admission, release of per-run memory |

### The 17 `runs/` baseline entries

| Importer | Feature file | Use | Removed by |
| --- | --- | --- | --- |
| `runs/retention.ts` | `autosave-cleanup.ts` | Refuses a reclaim while autosave cleanup is not confirmed | C1, deletion gate |
| `runs/retention.ts` | `delegation/results.ts` | Saves worker evidence before a reclaim | C1, reclaim preparation |
| `runs/retention.ts` | `preview/registration.ts` | Releases the preview before a reclaim | C1, reclaim preparation |
| `runs/store.ts` | `artifacts/lifecycle.ts` | Removes artifacts with the history | C1, removal cleanup |
| `runs/store.ts` | `autosave-cleanup.ts` | Refuses a deletion; clears autosave state with the history | C1, gate and cleanup |
| `runs/store.ts` | `jobs/job.ts` | Keeps the tmp directory while a job runs in it | C1, deletion gate (`archive-tmp`) |
| `runs/run-claims.ts` | `delegation/process-liveness.ts` | Process liveness of a claim | C2, pure helpers to `core/` |
| `runs/store.ts` | `delegation/process-liveness.ts` | `processStartToken`, process record types | C2, pure helpers to `core/` |
| `runs/worker-execution.ts` | `delegation/process-liveness.ts` | `describeProcesses`, `isCurrentProcess` | C2, pure helpers to `core/` |
| `runs/worker-resource-holders.ts` | `delegation/process-liveness.ts` | `isCurrentProcess`, `recordedProcessLive` | C2, pure helpers to `core/` |
| `runs/arm-repo-handle.ts` | `server/forge/index.ts` | Finds the repository through the forge | C2, the caller passes the resolver |
| `runs/auto-name.ts` | `workspace/agent-profiles.ts` | The profile env for auto-naming | C2, the caller passes the env |
| `runs/owned-run-create.ts` | `delegation/capacity.ts` | Admits a worker spawn | C2, the caller passes the check |
| `runs/owned-run-create.ts` | `delegation/execution-identity.ts` | Parses the worker identity | D5, the worker files move to `delegation/` |
| `runs/store.ts` | `delegation/execution-identity.ts` | Reads and writes `<id>.identity.json` | D5 |
| `runs/store.ts` | `worker-scope/scope.ts` | Reads and writes `<id>.scope.json` | D5 |
| `runs/store.ts` | `worker-scope/worker-scopes.ts` | `WorkerScopes` for worker resource safety | D5 |

No feature record type is part of the `RunRecord` schema; these types belong to private sidecar
files. `delegation/execution-identity.ts` depends on `feature:accounts`, so it cannot move to
`core/`; the worker files move out of `runs/` instead.

## Owner decisions (2026-11-21)

1. **The lifecycle has six events, each with a first-party listener.** Approved as proposed. The
   roadmap's rule 1 allows no API without a first-party user, so step, turn and wait events wait
   for one. Delivery is synchronous, at the same moment as the emitter on each path. A listener
   that throws is logged, and the other listeners still run. There is no replay: a listener gets
   no current runs when it subscribes, and `run.updated` carries the state before the change, so
   no listener keeps a map of every run.
2. **Removal uses three named slots in one process-wide registry.** The owner chose three slots
   over one hook with three parts: a deletion gate, a reclaim preparation and a removal cleanup.
   `registerBuiltInRunSlots()` fills the registry from `src/index.ts`, as
   `registerBuiltInRunners()` fills the runner registry. The other baseline entries go by moving
   pure helpers to `core/`, by parameters that the caller passes, and by moving the worker sidecar
   files to `delegation/`.
3. **The store splits into topic objects behind ports.** Approved as proposed. The port types come
   first. Then each topic leaves the class as one module that implements its port, with no
   forwarding method on `RunStore`. A forwarding facade cannot reach 1,000 lines: forwarding about
   213 methods costs about 650 lines alone.
4. **This task ends after the spec pull request.** The slices run as separate tasks, one child
   issue each.

## Design

### The lifecycle

`runs/lifecycle.ts` (core) declares the event types and `RunLifecycle`. The store builds one
instance in `RunStore.open` and exposes it as `store.lifecycle`, typed by the port
`RunLifecycleSource`. Nothing else publishes to it.

| Event | Payload | Published when |
| --- | --- | --- |
| `run.created` | `run` | `createRun` and owned-run creation add the run |
| `run.updated` | `run`, `before`, `source?` | Every change that emits `run` today, except creation: committed writes, debounced writes, `republish` and conflicts. `source` keeps today's `CommitSource` values, plus `conflict` |
| `run.status-changed` | `run`, `exit`, `from`, `to` | A write that changes `status`. `exit` is the `RunExitId` that `applyExit` applied, `conflict` when another writer's status wins, or `patch` when `updateRun` writes `status` directly, which only test fixtures do today. It follows the `run.updated` of the same write |
| `run.deleted` | `runId` | Where `deleted` is emitted today |
| `run.event` | `runId`, `event` | Where `event` is emitted today |
| `store.closed` | none | Where `closed` is emitted today |

Rules:

- **`before` is a snapshot.** The store takes a shallow, frozen copy of the record before it
  applies the patch, at the entry of the write path. A debounced write takes it before the first
  in-place change. A write path that changes a nested value in place must replace the value
  instead, so that `before` stays true; A1 adds a test for each write path.
- **Timing does not change.** A committed write publishes after the commit. A debounced write
  publishes when `touch` runs, before its SQLite write, as `run` is emitted today. The feeds keep
  their timing.
- **A load publishes nothing.** Exits applied while a run loads (`loaded-run-exits.ts`,
  `settleOrphanedRun`, `legacy-waits.ts`) stay silent, as today.
- **Isolation.** `RunLifecycle` calls listeners in subscription order. A listener that throws is
  logged with its event type and run id, and the next listener runs. A listener may return a
  promise; the lifecycle does not await it and logs a rejection.
- **Nesting.** A listener may cause another publish, as `provider-auth-runtime.ts` does with
  `appendEvent`. The nested event is delivered at once, before the outer delivery continues, as
  `EventEmitter` does.
- **Subscription.** `subscribe(handlers)` takes a map from event type to handler and returns an
  unsubscribe function. The port `RunLifecycleSource` holds only `subscribe`. A test builds a
  `RunLifecycle` with no store and publishes to it.

Webhooks compare `deriveWebhookState(before)` with `deriveWebhookState(run)`, so the `seen` map
goes. A restart publishes nothing for the runs it loads, so the webhooks send no duplicate events.

### Removal slots

`runs/removal-slots.ts` (core) declares three slot types and the registry:

| Slot | Signature | Called by | On failure |
| --- | --- | --- | --- |
| Deletion gate | `refuse(runId, kind, dataDir): string \| undefined`, with `kind` one of `history`, `worktree`, `archive-tmp`, and `dataDir` the run's data dir | `canDeleteRun`, the worker resource safety check, `cleanupSafety` in retention, the archive of a settled family | A reason refuses the deletion. The caller keeps today's message and status code |
| Reclaim preparation | `prepare(run, { repoRoot, store }): Promise<void>`, with `store` typed by a port from `runs/ports.ts` | `reclaimWorktree`, before the worktree goes | The reclaim stops and returns `null`; the next pass retries, as today |
| Removal cleanup | `removed(runId, dataDir): void` | `removeRunHistoryBytes`, `removeOwedHistory` | Delegated runs: `deleteRun` returns `false` and the checkpoint stays for a retry. Plain runs: logged, as the best-effort path does today |

- Built-in slots: autosave (gate and cleanup), workers (preparation: worker evidence), artifacts
  (cleanup) and jobs (gate for `archive-tmp`). The worker checks of `canDeleteRun` and
  `cleanupSafety` read the store's private records, so they stay in the store in today's order.
  Preview has no slot: its host belongs to one `serve` process, and its release runs only once a
  removal goes ahead, after the clean and HEAD-reachable checks, and never blocks it. So
  `ReclaimOptions.previewHost` is typed structurally, `{ release(runId): Promise<void> }`
  (planner decision, 2026-11-22).
- `registerBuiltInRunSlots()` lives in a `shell` file, because it imports the features. Each
  process entry calls it once, in `src/index.ts` before the CLI dispatch, beside
  `registerBuiltInRunners()`.
- **Fail closed.** A deletion, a reclaim or a family archive in a process whose registry was
  never sealed throws an error that names the missing registration, and removes nothing. Tests
  seal the registry through a testkit, with only the slots they need.

### Ports

`runs/ports.ts` (core) declares the ports. Features and the shell may import it. D1 replaces each
`Pick<RunStore, …>` and the `Partial<RunStore>` in `runs/retention.ts` with one port or an
intersection of ports, and types the test fakes by port.

| Port | Holds |
| --- | --- |
| `RunReads` | `getRun`, `isUnreadable` |
| `RunQueries` | `listRuns`, `listRunSummaries`, `persistedLiveRunIds`, `listForeignClaimedRunIds`, `withReadCache`, `findRunByClientRequestId`, `listBranchOwners`, `listConversationRootIds` and the other list and find methods |
| `RunFamilyReads` | `listWorkersOf`, `listOwnedWorkers` |
| `RunWrites` | `createRun`, `move`, `updateRun`, `addStep`, `updateStep`, `commitOutcome`, `commitConversation`, `commitDelegation` and the other commits |
| `RunEventLog` | `appendEvent`, `emitEphemeral`, `readEvents`, `readEventsAsync`, `hasProjection` |
| `TranscriptFacts` | `transcriptFacts`, `knownTranscriptFacts` and the prepare methods |
| `WorkerResults` | the worker result reads and `commitWorkerResult` |
| `WorkerExecutions` | the worker execution, scope and process methods |
| `RunRetention` | `canDeleteRun`, `deleteRun`, `fallbackDeleteError` and the archive methods |
| `RunAccess` | `writeRefusal`, `unavailable`, `sourceDataDir`, `redactText` |
| `RunLifecycleSource` | `subscribe` |
| `StoreHandle` | `close`, `flush` |

D1 fixes the method list of each port from the callers. A later slice may move a method between
ports when its topic moves.

### Topics leave the class

Each topic becomes one module under `runs/` that implements its port. The module gets a narrow
state object from the store, as `worker-result-commit.ts` and `archive-family.ts` do today. The
store exposes it as a field (`store.transcriptFacts`, `store.workerResults`), and callers either
use the field or receive the port. Call sites change, with no aliases and no forwarding methods
(AGENTS.md § Changing what already works). `getRun` and the other row reads stay methods on
`RunStore`, because they have about 456 call sites.

Topics leave in this order, the topic with the fewest callers first:

| Slice | Topic | About lines today |
| --- | --- | --- |
| D2 | Transcript facts | 110 |
| D3 | Retention and deletion | 175 |
| D4 | Worker results | 80 |
| D5 | Worker executions, scopes and processes; the sidecar files move to `delegation/` | 175 |
| D6 | Event log, marker references and redaction | 150 |
| D7 | Archive, merge and read flags; completion actions | 365 |
| D8 | Claims, ownership and pins; open, sources and fallback | 375 |
| D9 | Persistence: flush, persist, the fence, conflicts and the save debounce | 355 |
| D10 | List and find queries and the cold-read helpers | 520 |

The measured spans add up to about 2,300 lines and leave about 1,080. Each topic's private helpers
move with it, so the class reaches 1,000 lines. Each slice lowers the pin of `runs/store.ts` in
`file-length.baseline.json` and removes it at or below 1,000.

## Case tables

### Removal cases

The slots keep each path's behavior; this table is the reviewed list for C1.

| Path | Slots called, in order | Missing or unreadable record | Behavior at shipped defaults |
| --- | --- | --- | --- |
| `DELETE /runs/:id` (`server/run-checkout.ts`, `removalRefusal`) | gate `history`, then cleanup | `canDeleteRun` refuses an `invalid` role, as today | 409 with today's message on a refusal; 409 "history cleanup incomplete — retry deletion" when a delegated cleanup fails |
| `POST /runs/:id/remove-worktree` | gate `worktree` | As today | 409 with today's message on a refusal |
| Worker collect (`delegation/service.ts`) | gate `history` | As today | As today |
| Worktree reclaim (`reclaimWorktrees`: boot, project context, run settlement, `POST /worktrees/reclaim`; `POST /worktrees/:runId/reclaim`) | gate `worktree`, preparation, gate `worktree` again before removal | The run is skipped | A refusal or a failed preparation returns `null`; the next pass retries |
| Worker family end (`delegation/family-end.ts`, `cleanupSafety`) | gate `worktree` | As today | As today |
| Archive of a settled family (`pruneOldRuns`) | gate `archive-tmp` | As today | The tmp directory stays while a job runs in it |
| Plain run history delete | gate `history`, then cleanup after the commit | As today | A cleanup failure is logged; the row is gone |
| Any path, registry not sealed | none | — | Throws; nothing is removed |

### Lifecycle delivery cases

| Case | Events, in order | Timing |
| --- | --- | --- |
| `createRun` | `run.created` | When `touch` runs, as `run` today |
| Committed `move` that changes status | `run.updated`, `run.status-changed`, then `run.event` for the `lifecycle` event | After the commit |
| Debounced `move` or `updateRun` | `run.updated` (and `run.status-changed` when status changed) | When `touch` runs, before the SQLite write |
| `updateRun` with a `status` in the patch (test fixtures) | `run.updated`, then `run.status-changed` with exit `patch` | As the write path it takes |
| `appendEvent` that finds a PR reference | `run.event`, then `run.updated` | As today |
| Conflict: another writer's row wins | `run.updated` with source `conflict`, and `run.status-changed` with exit `conflict` when status differs | During `handleConflicts` |
| Delete of a plain run | `run.deleted` | Before the debounced write, as today |
| Delete of a delegated run | `run.deleted` | After the commit |
| Load or adoption that applies an exit | none | — |
| A listener throws | The other listeners still get the event | — |
| `close()` | `store.closed` | Before the database closes |
