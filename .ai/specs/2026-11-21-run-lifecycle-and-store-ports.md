# Run lifecycle and run store ports
Status: done

Step 2 of [the plugin core roadmap](2026-11-18-plugin-core-roadmap.md), epic
hearsay-tools/squawk#4007. Baseline: `main` at `8a331af92`. The owner decided the open points on
2026-11-21 in task 59568fef. The work ran as slices, one child issue each; the
[implementation record](#implementation-record) lists them, and
[ADR 0068](../../docs/adr/0068-publish-a-run-lifecycle-and-reach-the-run-store-through-ports.md)
records the result.

## Goal

A feature follows a run through typed lifecycle events, not through `RunStore`'s emitter. A run's
deletion asks registered slots, not feature code that `runs/` imports. Callers reach the store
through named ports, and the `RunStore` class is at most 1,000 lines. After this step:

- `RunStore` extends no `EventEmitter`, and no file outside `runs/` calls `on` or `off` on a store;
- a test receives the lifecycle events of one run in order and opens no run store;
- the webhook, activity and reports-index lifecycle listener tests run against lifecycle events
  and ports, with no real run store;
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
  events in order with no store; the lifecycle listener tests of the webhook, activity and reports
  index (`runs/webhook.test.ts`, `activity/publisher.test.ts`, `activity/tool-activity.test.ts`,
  `server/reports-watch.test.ts`) build no `RunStore`. `activity/read-model-decodes.test.ts`
  opens a real store, because it tests the read model's decoding of cold rows, not a listener.
  Each slice's pull request lists the Squeal selection for its files before and after.
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

### What the emitter sent

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

`runs/lifecycle.ts` (core) declares the event types and `RunLifecycle`. Each store builds one
instance when it is constructed and exposes it as `store.lifecycle`, typed by the port
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
- **`run` is this write's value.** On a commit, `run` is a shallow frozen copy of what the write
  wrote. On a debounced write, a republish or a conflict, it is the held record, which a later
  write changes in place. `run.status-changed` reads `to` before any listener runs. A listener
  that needs the current record re-reads it with `store.getRun(run.id) ?? run`; a listener that
  compares `before` with `run` keeps the payload (planner decision, built in B3).
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
- **Teardown.** A listener's owner keeps the unsubscribe and calls it when it stops.
  `ProviderRuntimeAuthObserver.watch` and `armPreview` return theirs. A
  `ProjectContexts.onStoreCreated` listener may return a cleanup, which runs right after
  `store.close()`.
- **Tests.** The lifecycle swallows a listener's throw, so a test never asserts inside a handler:
  it records, then asserts after the write (`runs/lifecycle-assertion-guard.test.ts`).
  `runs/emitter-guard.test.ts` refuses the old emitter calls outside `runs/`.

Webhooks subscribe to `run.created` and `run.updated` and compare `deriveWebhookState(before)`
with `deriveWebhookState(run)`, so the `seen` map goes. A restart publishes nothing for the runs it loads, so the webhooks send no duplicate events.

### Removal slots

`runs/removal-slots.ts` (core) declares three slot types and the registry:

| Slot | Signature | Called by | On failure |
| --- | --- | --- | --- |
| Deletion gate | `refuse(runId, kind, dataDir): string \| undefined`, with `kind` one of `history`, `worktree`, `archive-tmp`, `scratch`, and `dataDir` the run's data dir | `canDeleteRun`, the worker resource safety check, `cleanupSafety` in retention, the archive of a settled family, the terminal scratch reap (`reapTerminalScratch`), the startup orphan sweep (`sweepAgentTmpDirs`) | A reason refuses the deletion. The caller keeps today's message and status code |
| Reclaim preparation | `prepare(run, { repoRoot, store }): Promise<void>`, with `store` typed by a port from `runs/ports.ts` | `reclaimWorktree`, before the worktree goes | The reclaim stops and returns `null`; the next pass retries, as today |
| Removal cleanup | `removed(runId, dataDir): void` | `removeRunHistoryBytes`, `removeOwedHistory` | Delegated runs: `deleteRun` returns `false` and the checkpoint stays for a retry. Plain runs: logged, as the best-effort path does today |

- Built-in slots: autosave (gate and cleanup), workers (preparation: worker evidence), artifacts
  (cleanup) and jobs (gate for `archive-tmp` and `scratch`). The worker checks of `canDeleteRun` and
  `cleanupSafety` read the worker records through `store.workerExecutions`, in today's order.
  Preview has no slot: its host belongs to one `serve` process, and its release runs only once a
  removal goes ahead, after the clean and HEAD-reachable checks, and never blocks it. So
  `ReclaimOptions.previewHost` is typed structurally, `{ release(runId): Promise<void> }`
  (planner decision, 2026-11-22).
- `registerBuiltInRunSlots()` lives in a `shell` file, because it imports the features. Each
  process entry calls it once, in `src/index.ts` before the CLI dispatch, beside
  `registerBuiltInRunners()`.
- **Fail closed.** A deletion, a reclaim, a family archive, a worker family end, a worker
  admission, the terminal scratch reap or the startup orphan sweep in a process whose registry
  was never sealed throws an error that names the missing registration, and removes nothing.
  Tests seal the registry through a shared testkit (`runs/removal-slots.testkit.ts`,
  `built-in-run-slots.testkit.ts`), with only the slots they need, and no global setup.

### Ports

`runs/ports.ts` (core) declares the ports. Features and the shell may import it. Each port is an
interface whose members are `RunStore` method types (`RunStore['getRun']`) or written signatures
of the topic that implements them. A caller takes a port, an intersection of ports, or a `Pick` of
one port (`Pick<RunEventLog, 'appendEvent'>`), never a `Pick`, `Partial`, `Omit`, `Required` or
`Readonly` of `RunStore`; test fakes are typed by port. `runs/ports-guard.test.ts` refuses those
forms in every non-test file, and `RunStore[…]` (`import('…').RunStore` included) outside
`runs/store.ts` and `runs/ports.ts`.

The ports on `main` at `0d92ba360`. *Added* marks a port this table did not plan; a port that the
table planned under another name says so.

| Port | Holds | Implemented by |
| --- | --- | --- |
| `RunLookup` (added) | `getRun` | `RunStore` |
| `RunReads` | `RunLookup`, `isUnreadable` | `RunStore` |
| `RunQueries` | `listRuns`, `listRunSummaries`, `listPeerTaskSummaries`, `listArchivedRuns`, `searchRunSummaries`, `withReadCache`, `findRunByClientRequestId`, `listBranchOwners`, `listConversationRootIds` and the other list and find methods | `store.queries` (`runs/run-queries.ts`) |
| `RunFamilyReads` | `listWorkersOf`, `listOwnedWorkers` | `store.queries` |
| `RunWrites` | `createRun`, `createOwnedRun`, `move`, `updateRun`, `addStep`, `updateStep`, `commitOutcome`, `commitConversation`, `commitDelegation` and the other commits | `RunStore` |
| `RunEventLog` | `appendEvent`, `emitEphemeral`, `readEvents`, `readEventsAsync`, `hasProjection` | `store.eventLog` (`runs/event-log.ts`) |
| `RunMarkerRefs` (added) | `applyMarkerRefs`, `recordCreatedPr` | `store.eventLog` |
| `RunRedaction` (added) | `redactText`, `registerSessionSecret`, `containsSessionSecret` | `store.redaction` (`runs/run-redaction.ts`) |
| `TranscriptFactsPort` (planned as `TranscriptFacts`, the name of the facts type) | `transcriptFacts`, `knownTranscriptFacts`, `prepareTranscriptFacts`, `prepareRecoveryFacts`, `factsWarmIdle` | `store.transcriptFacts` (`runs/transcript-facts-topic.ts`) |
| `WorkerResults` | the worker result reads, `workerResultSnapshotPath`, `commitWorkerResult` | `store.workerResults` (`runs/worker-results.ts`) |
| `WorkerExecutions` | the worker execution, resource, scratch and process methods, `spawnScope`, `scopes` | `store.workerExecutions` (`delegation/worker-executions.ts`, through `runs/worker-executions-registry.ts`) |
| `WorkerExecutionRecords` (added) | the identity, execution, process and scope record writes and paths, `workerDeletionEvidence`: what the store's own paths use | `store.workerExecutions` |
| `WorkerScopeControl` (added) | `empty`, `stopped`, `kill` | `store.workerExecutions.scopes` |
| `RunRetention` | `canDeleteRun`, `deleteRun`, `fallbackDeleteError` | `store.retention` (`runs/run-retention.ts`) |
| `RunArchive` (added, split from `RunRetention`) | `setArchived`, `archiveFinished`, the archive-on-merge methods, `compressArchivedHistory`, `historyIdle` | `store.archive` (`runs/run-archive.ts`) |
| `RunCompletionActions` (added) | `listCompletionCandidates`, `canCompleteAction`, `claimCompletionAction`, `completeAction` | `store.archive` |
| `RunReadFlags` (added) | `setPinned`, `setRead`, `setUnread`, `markAllRead` | `store.readFlags` (`runs/run-read-flags.ts`) |
| `RunAccess` | `writeRefusal`, `sourceDataDir`, `isFallbackRun`, `hasFallbackRun`, `runOwnership` | `store.claims` (`runs/run-claims-topic.ts`) |
| `RunClaims` (added) | `adoptFamily`, `adoptFallbackFamily`, `listForeignClaimedRunIds`, `persistedLiveRunIds` | `store.claims` |
| `RunPins` (added) | `pin`, `unpin`, `republish` | `store.runPins` (`runs/run-pins.ts`) |
| `RunRepoHandle` (added) | `setRepoHandle` | `store.repoScope` (`runs/run-repo-scope.ts`) |
| `RunPersistence` (added) | `flush`, `reportSource` | `store.persistence` (`runs/run-persistence.ts`) |
| `RunLifecycleSource` | `subscribe` | `store.lifecycle` (`runs/lifecycle.ts`) |
| `StoreHandle` | `unavailable`, `close` | `RunStore` |
| `LiveRunReads` (added) | `queries.listRuns`, `claims.persistedLiveRunIds`, `getRun`: what `projectLiveTasks` reads | `RunStore`, or the read-only files |

`runs/ports.ts` also names the inputs `RunPatchInput`, `CreateRunInput` and `RunEventInput`, so a
caller never writes `Parameters<RunStore[…]>`.

### Topics leave the class

Each topic becomes one module under `runs/` that implements its port. The module gets a narrow
state object from the store, as `worker-result-commit.ts` and `archive-family.ts` do today. The
store exposes it as a field (`store.transcriptFacts`, `store.workerResults`), and callers either
use the field or receive the port. Call sites change, with no aliases and no forwarding methods
(AGENTS.md § Changing what already works). What stays on `RunStore`: `getRun` and `isUnreadable`
(the reads with the most callers), the `RunWrites` commits, the inbox input methods, `liveReadSnapshot`, the
private `change()`, the constructors `open` and `unavailable` (with the private `openOnce`), the
`unavailable` getter, `close`, and the topic fields.

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

D5 is the one topic whose module is a feature: the worker sidecar code moves to
`delegation/worker-executions.ts`, which the core may not import. So the store reaches it through
a core registry, `runs/worker-executions-registry.ts`: one factory per process, registered inside
`registerBuiltInRunSlots()`, and built lazily as `store.workerExecutions` on first use. It is not a
fourth removal slot. A process with no factory fails closed: the first use throws before any side
effect. Callers take the `WorkerExecutions` port; the members only the store's own paths use
(owned-run creation, the archive checks and the delegated deletion) form `WorkerExecutionRecords`.
Tests get the factory through the shared store and RunManager testkits (planner decision,
2026-11-22).

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
| Terminal scratch reap (`reapTerminalScratch`, D3) | gate `scratch`, after today's checks | The scratch stays | The scratch stays while autosave cleanup is unconfirmed or a job runs in it, as today |
| Startup orphan sweep (`sweepAgentTmpDirs`, D3) | gate `scratch` for each orphan run id | — | An orphan's directories stay while a gate refuses its scratch |
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

## Implementation record

Epic hearsay-tools/squawk#4007. Every slice merged as one squash commit on `main`. The result is
[ADR 0068](../../docs/adr/0068-publish-a-run-lifecycle-and-reach-the-run-store-through-ports.md).

| Slice | Issue | Pull request | Commit on `main` | `runs/store.ts` lines after |
| --- | --- | --- | --- | --- |
| A1. The lifecycle module | hearsay-tools/squawk#4027 | hearsay-tools/squawk#4053 | `75c342f66` | |
| A2. Webhooks move | hearsay-tools/squawk#4028 | hearsay-tools/squawk#4056 | `8fc853ad8` | |
| D1. Port types | hearsay-tools/squawk#4035 | hearsay-tools/squawk#4062 | `65e98db10` | |
| B3. RunManager listeners move | hearsay-tools/squawk#4031 | hearsay-tools/squawk#4065 | `8486490e5` | |
| B1. Feature listeners move | hearsay-tools/squawk#4029 | hearsay-tools/squawk#4067 | `2256f6bf7` | |
| B2. Shell feeds move | hearsay-tools/squawk#4030 | hearsay-tools/squawk#4068 | `3e62a1e09` | |
| B4. The emitter goes | hearsay-tools/squawk#4032 | hearsay-tools/squawk#4070 | `ca14145ea` | 3,370 |
| C1. Removal slots | hearsay-tools/squawk#4033 | hearsay-tools/squawk#4073 | `28b369d60` | 3,368 |
| C2. Pure helpers to core, and parameters | hearsay-tools/squawk#4034 | hearsay-tools/squawk#4074 | `aa23e69f6` | |
| D2. Transcript facts | hearsay-tools/squawk#4036 | hearsay-tools/squawk#4075 | `81d46a404` | 3,286 |
| D3. Retention and deletion; scratch removal through the slots | hearsay-tools/squawk#4037 | hearsay-tools/squawk#4076 | `cec26d74a` | 3,120 |
| D4. Worker results | hearsay-tools/squawk#4038 | hearsay-tools/squawk#4079 | `3a64a4e25` | 3,066 |
| D5. Worker executions, processes, identity and scope to `delegation/` | hearsay-tools/squawk#4039 | hearsay-tools/squawk#4080 | `8ff2e7b13` | 2,862 |
| D6. Event log, marker references and redaction | hearsay-tools/squawk#4040 | hearsay-tools/squawk#4082 | `83342c2e0` | 2,674 |
| D7. Archive, merge and read flags; completion actions | hearsay-tools/squawk#4041 | hearsay-tools/squawk#4084 | `ea6e4dbdf` | 2,313 |
| D8. Claims, ownership, pins; open helpers and sources | hearsay-tools/squawk#4042 | hearsay-tools/squawk#4088 | `13c09e5a6` | 1,942 |
| D9. Persistence | hearsay-tools/squawk#4043 | hearsay-tools/squawk#4089 | `532821410` | 1,616 |
| D10. List and find queries; cold reads | hearsay-tools/squawk#4044 | hearsay-tools/squawk#4090 | `0d92ba360` | 990 |
| E1. ADR, docs, spec close-out | hearsay-tools/squawk#4045 | The pull request that set this spec to done | | |

D1 ran inside phase A beside A2; phase B started after A2 and D1.

### Changed moments

Each change stays within owner decision 1; the planner accepted A2, B1, C1 and D3, and the plan
set B3. ADR 0068 has the table.

- A2: the webhook subscribes to `run.created` and `run.updated` only. A run deleted here and
  restored by another writer's row, and a run first seen through another writer, no longer send
  `task.subscribed`; the second sends `task.status` only if its derived state changed. An exit
  applied at load no longer causes a late `task.status`.
- B1: the reports index reads `run.status-changed` for settlement. An exit applied at load or
  adoption, and a conflict on a fallback run with no staged copy, lose the immediate settlement
  scan; the reports-dirty mark still rescans.
- B3: a throwing family reconciler is logged and no longer stops the other listeners or the write.
- C1: a plain-run delete clears autosave in the cleanup after the commit, not before it; a
  plain-run cleanup failure is logged, not silent.
- D3: the orphan scratch sweep and the terminal scratch reap assert the seal at entry and ask the
  `scratch` gate; in an unsealed process both throw before any side effect.

### Decisions made during the work

- The `run` of `run.updated` and `run.status-changed` is a frozen copy on a commit and the held
  record otherwise; `to` is read per write before delivery (planner, phase A item 5; built in B3).
- Removal slot signatures take their context as parameters; `scratch` is a new deletion kind, not
  a reuse of `archive-tmp` (planner, C1 and D3).
- Preview has no slot; `ReclaimOptions.previewHost` is structural (planner, C1).
- A feature-owned topic registers through `runs/worker-executions-registry.ts`; it is not a fourth
  removal slot (planner, D5).
- `open`, `openOnce` and `unavailable` stay on `RunStore` as its constructors; open-time work moves
  out to `runs/store-open.ts`, `store.claims` and `store.runPins` (planner, D8).
- `close` stays on `RunStore` and calls `store.persistence.closeSave()`; `flush` left
  `StoreHandle` for `RunPersistence` (D9).
- `RepoHandle`, `ARCHIVED_WINDOW`, the decode helpers and the record schema stay in
  `runs/store.ts`; moving the decode helpers alone makes an import cycle (planner, D10).
- Saved worker sidecar files and saved runs keep their names, paths, modes and formats, proven by
  `delegation/worker-sidecars-compat.test.ts` and `runs/run-persistence-saved-runs.test.ts`.

### Numbers

| Item | At `8a331af92` | At `0d92ba360` |
| --- | --- | --- |
| `runs/store.ts` | 3,381 lines, pinned in `file-length.baseline.json` | 990 lines, no entry |
| Production listener files on the store emitter | 12 | 0 |
| Test files on the store emitter | 42 (43 when B4 moved them) | 0 |
| `runs/` entries in `layer-import.baseline.json` | 17 | 0 (11 after C1, 4 after C2, 0 after D5) |
| `Pick<RunStore` sites | 41 | 0 |
| `Pick<RunStore`, `Partial<RunStore` or `Parameters<RunStore` matches | 79 in 52 files | `runs/store.ts` only |
| Test files Squeal selects for `runs/store.ts` | about 870 (epic estimate); 895 at `8ff2e7b13` | 889 |

The selection barely moved. The lifecycle listener tests of A2 and B1 build a `RunLifecycle` and
port fakes, but most other tests still build the whole store through testkits, so the ports did
not lower the count (roadmap rule 5).

### Open seams

- `delegation/removal-slot.ts` casts `ReclaimContext.store` to `RunStore` for
  `collectWorkerEvidence`: hearsay-tools/squawk#4091.
- `handleConflicts` takes `before` from the staged record for a row the store does not hold (phase
  A item 8). A fix changes a published payload, so it waits for a decision:
  hearsay-tools/squawk#4092.

Defects found in moved code and filed outside the epic: hearsay-tools/squawk#4077,
hearsay-tools/squawk#4078, hearsay-tools/squawk#4085, hearsay-tools/squawk#4086 and
hearsay-tools/squawk#4087.
