# Run lifecycle and run store ports: plan
Status: active

The plan for [the spec](2026-11-21-run-lifecycle-and-store-ports.md), epic
hearsay-tools/squawk#4007. Baseline: `main` at `8a331af92`. Each slice is one pull request into
`main` and one child issue. Check a slice against the current `main` before it starts: the code
moves between slices.

## Rules for every slice

- `main` stays usable after each slice, at shipped defaults.
- Slices that run at the same time touch different files. Each edit to `runs/store.ts` waits for
  the slice before it: A1, B4, C1, C2, then D2 to D10 in order.
- `runs/store.ts` and `server/server.ts` are pinned at their exact length. A slice that adds a
  line there removes one, or lowers the pin by what it removed.
- An edit to `runs/store.ts` makes Squeal select about 870 test files. Keep the edits to that file
  in few commits, and follow the [Squeal wait bound](../../docs/sdlc/ci.md#squeal-wait-bound).
- Each slice lists in its pull request the test files that Squeal selects for the files it moves,
  before and after (roadmap rule 5). An answer with `selection.reason` `unsynced` is incomplete;
  say so.
- No aliases, no forwarding methods and no compatibility notes. Saved runs still open.
- A moved declaration keeps its name and body. A test moves only with its code.

## Order

| Phase | Slices | Starts after |
| --- | --- | --- |
| A | A1, then A2 | — |
| B | B1, B2 and B3 in parallel, then B4 | A2 merged |
| C | C1, then C2 | B4 merged |
| D | D1 beside phase B or C, when its files differ; then D2 to D10 in order | D1: A1 merged. D2: C2 merged |
| E | E1 | D10 merged |

## A1. The lifecycle module

Issue: hearsay-tools/squawk#4027.

- Add `runs/lifecycle.ts`: the six event types, `RunLifecycle` with `subscribe` and `publish`,
  and the port `RunLifecycleSource`.
- The store builds one instance and publishes beside each `this.emit(`. It takes the `before`
  snapshot at the entry of each write path, and the `exit`, `from` and `to` where `applyExit`
  runs.
- Listener isolation and promise logging are in `RunLifecycle`. The emitter keeps today's
  behavior until B4 removes it.
- Tests: `runs/lifecycle.test.ts` publishes to a lifecycle with no store, and checks order,
  isolation, nesting and unsubscribe. Store tests check each row of the spec's
  [Lifecycle delivery cases](2026-11-21-run-lifecycle-and-store-ports.md#lifecycle-delivery-cases),
  and that `before` holds the old values on each write path, the debounced path included.
- Files: `runs/lifecycle.ts`, `runs/store.ts`, the write-path helpers that `applyExit` runs in
  (`runs/outcome-commit.ts`, `runs/record-write-rules.ts`), their tests.

## A2. Webhooks move

Issue: hearsay-tools/squawk#4028.

- `runs/webhook.ts` subscribes to `run.created`, `run.updated` and `run.deleted`, and compares
  `deriveWebhookState(before)` with `deriveWebhookState(run)`. The `seen` map and its seed from
  `listRunSummaries()` go.
- Its tests build a `RunLifecycle` and the ports the webhook needs, with no `RunStore`.
- Files: `runs/webhook.ts`, its tests, its wiring.

## B1. Feature listeners move

Issue: hearsay-tools/squawk#4029.

- `activity/publisher.ts`, `activity/tool-activity.ts`, `artifacts/reports-index.ts` and
  `delegation/worker-cleanup.ts` subscribe to the lifecycle. Reports-index keeps sending every
  `run.created` and `run.updated` to its report watch, for report metadata and live scans, and
  reads `run.status-changed` for settlement, so its `live` set goes. Worker cleanup checks
  `failedBeforeFirstStep` on every `run.updated`, not only on status changes, because a worker
  execution can complete with no status change. `LiveActivityStore` and the `on` overloads in
  `tool-activity.ts` go.
- The activity and reports-index tests run against a lifecycle and ports, with no real store. A
  reports-index test checks that an update with no status change, such as a title change, still
  reaches the report watch.
- Files: those four files, their testkits and tests.

## B2. Shell feeds move

Issue: hearsay-tools/squawk#4030.

- `headless-run.ts`, `server/run-event-feed.ts`, `server/workspace-run-feed.ts`, the two feeds in
  `server/server.ts`, `server/project-context.ts` and `server/provider-auth-runtime.ts` subscribe
  to the lifecycle. The cockpit gets the same payloads at the same moments.
- Tests: the existing feed tests pass unchanged in what they assert; each listener's
  unsubscribe on close is checked.
- Files: those files and their tests. `server/server.ts` keeps its pin.

## B3. RunManager listeners move

Issue: hearsay-tools/squawk#4031.

- `workflows/run.ts` subscribes for `FamilyReconciler.onDelegationRun`,
  `wakeAdmission.onRunDeleted` and the release of per-run memory. The reconciler reads `source`
  from `run.updated`.
- A test checks that a reconciler that throws no longer stops the other listeners, and that the
  error is logged.
- Files: `workflows/run.ts`, `workflows/run/family-reconciler.ts`,
  `workflows/run/wake-admission.ts`, `workflows/run/run-memory.ts`, their tests.

## B4. The emitter goes

Issue: hearsay-tools/squawk#4032.

- `RunStore` extends no `EventEmitter`. `setMaxListeners` and every `this.emit(` go.
- The test files that still call `.on` or `.once` on a store, and the testkits
  (`workflows/run-fixture.testkit.ts` and the parity testkits), subscribe to `store.lifecycle`.
- A lint rule or a test fails a file outside `runs/` that calls `on` or `off` on a store.
- Files: `runs/store.ts`, the remaining test files and testkits.

## C1. Removal slots

Issue: hearsay-tools/squawk#4033.

- Add `runs/removal-slots.ts`: the deletion gate, the reclaim preparation and the removal
  cleanup, the registry, and its seal. Add `registerBuiltInRunSlots()` in a new `shell` file, and
  call it from `src/index.ts` beside `registerBuiltInRunners()`.
- Autosave, workers, artifacts, jobs and preview each export their slots.
- `runs/store.ts` and `runs/retention.ts` ask the registry. Their imports of
  `autosave-cleanup.ts`, `artifacts/lifecycle.ts`, `jobs/job.ts`, `delegation/results.ts` and
  `preview/registration.ts` go, with their six baseline entries.
- Tests: each row of the spec's
  [Removal cases](2026-11-21-run-lifecycle-and-store-ports.md#removal-cases) at today's message
  and status; a removal with an unsealed registry throws and removes nothing; one test per
  process entry checks that the registry is sealed.
- Files: `runs/removal-slots.ts`, the new shell file, `src/index.ts`, `runs/store.ts`,
  `runs/retention.ts`, the five features' slot files, `lint/layer-import.baseline.json`.

## C2. Pure helpers to core, and parameters

Issue: hearsay-tools/squawk#4034.

- Move `isCurrentProcess`, `describeProcesses`, `recordedProcessLive`, `processStartToken` and
  the `WorkerProcessRecord` type from `delegation/process-liveness.ts` to `core/`. The
  re-exports of `core/process-stat.ts` go; importers name the core file.
- `runs/arm-repo-handle.ts` takes the forge resolver, `runs/auto-name.ts` the profile env, and
  `runs/owned-run-create.ts` the spawn capacity check, as parameters from their callers.
- Seven baseline entries go.
- Files: `delegation/process-liveness.ts`, a `core/` file, `runs/run-claims.ts`,
  `runs/worker-execution.ts`, `runs/worker-resource-holders.ts`, `runs/store.ts`,
  `runs/arm-repo-handle.ts`, `runs/auto-name.ts`, `runs/owned-run-create.ts`, their callers,
  `lint/layer-import.baseline.json`.

## D1. Port types

Issue: hearsay-tools/squawk#4035.

- Add `runs/ports.ts` with the ports in the spec. Each `Pick<RunStore, …>`, the
  `Partial<RunStore>` in `runs/retention.ts` and the `Parameters<RunStore[…]>` types in
  `workflows/run/` take a port. The test fakes (`activity/activity.testkit.ts`,
  `preview/host.testkit.ts` and the `as unknown as RunStore` casts that build partial fakes) are
  typed by port.
- A lint rule or a test refuses a `Pick<RunStore, …>` in any non-test file, `runs/` included.
- Types only; no behavior changes.
- Files: `runs/ports.ts` and the 28 non-test files with a `Pick`, `runs/live-tasks.ts` and
  `runs/supervised.ts` included. Run it when no B slice edits the same
  file.

## D2 to D10. One topic each

Each slice moves one topic out of `RunStore` into a module that implements its port, as the
spec's [Topics leave the class](2026-11-21-run-lifecycle-and-store-ports.md#topics-leave-the-class)
lists:

| Slice | Topic | Note |
| --- | --- | --- |
| D2 (hearsay-tools/squawk#4036) | Transcript facts | `store.transcriptFacts` |
| D3 (hearsay-tools/squawk#4037) | Retention and deletion | Uses the removal slots of C1 |
| D4 (hearsay-tools/squawk#4038) | Worker results | Beside `runs/worker-result-commit.ts` |
| D5 (hearsay-tools/squawk#4039) | Worker executions, scopes and processes | The identity, process and scope files move to `delegation/`; the last four `runs/` baseline entries go |
| D6 (hearsay-tools/squawk#4040) | Event log, marker references and redaction | Publishes `run.event` |
| D7 (hearsay-tools/squawk#4041) | Archive, merge and read flags; completion actions | Beside `runs/archive-family.ts` |
| D8 (hearsay-tools/squawk#4042) | Claims, ownership and pins; open, sources and fallback | Beside `runs/claim-families.ts` |
| D9 (hearsay-tools/squawk#4043) | Persistence | Flush, persist, the fence, conflicts, the save debounce |
| D10 (hearsay-tools/squawk#4044) | List and find queries; cold reads | `runs/store.ts` reaches 1,000 lines or fewer and leaves `file-length.baseline.json` |

Each slice lowers the pin of `runs/store.ts` by the lines it moved, and moves the topic's private
helpers with it. The topic's callers take its port or its field; no forwarding method stays on
`RunStore`.

## E1. Close out

Issue: hearsay-tools/squawk#4045.

- An ADR records the lifecycle, the removal slots and the ports.
- `docs/areas/runs-store.md` and `docs/areas/realtime-events.md` describe the lifecycle and the
  ports in place of the emitter.
- The spec gets `Status: done` and an implementation record; this plan is deleted.
- The roadmap's steps table marks step 2 done.
