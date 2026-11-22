# Publish a run lifecycle, ask removal slots and reach the run store through ports

Approved design: [run lifecycle and run store ports](../../.ai/specs/2026-11-21-run-lifecycle-and-store-ports.md),
with the owner's four decisions of 2026-11-21. Epic hearsay-tools/squawk#4007, step 2 of the
[plugin core roadmap](../../.ai/specs/2026-11-18-plugin-core-roadmap.md). It applies
[ADR 0065](0065-define-the-core-by-a-layer-map.md): the core declares a seam, and a feature uses
it. The run store stays the only writer of status and exit fields
([ADR 0056](0056-let-the-run-store-own-run-exits.md), [ADR 0064](0064-record-run-lifecycle-facts.md)).

## Decision

A feature follows a run through typed lifecycle events, a run's removal asks registered slots,
and a caller reaches the store through named ports. Paths are under `packages/cezar/src/`.

**The lifecycle** (`runs/lifecycle.ts`). The store builds one `RunLifecycle` and exposes it as
`store.lifecycle`, typed by the port `RunLifecycleSource` (`subscribe` only). `RunStore` extends no
`EventEmitter`. Six events, each with a first-party listener: `run.created`, `run.updated`
(`run`, `before`, `source?`), `run.status-changed` (`run`, `exit`, `from`, `to`), `run.deleted`,
`run.event` and `store.closed`.

- Delivery is synchronous, in subscription order, at the moment the store writes. A listener that
  throws is logged with the event type and run id, and the next listener runs. A returned promise
  is not awaited; a rejection is logged. A publish from inside a listener is delivered at once.
- `before` is a shallow frozen copy taken at the entry of the write path. On a commit, `run` is a
  shallow frozen copy of what the write wrote. On a debounced write, a republish or a conflict,
  `run` is the held record, which a later write changes in place. `run.status-changed` reads `to`
  before any listener runs. A listener that needs the current record re-reads it with
  `store.getRun(run.id) ?? run`; a listener that compares `before` with `run` keeps the payload.
- A store write replaces a nested value (the steps array, a step object) and never changes it in
  place, so `before` stays true.
- There is no replay: a subscriber gets no current runs. A load or an adoption that applies an exit
  publishes nothing. So no listener keeps a map of every run (owner decision 1).
- `subscribe` returns the unsubscribe. A `ProjectContexts.onStoreCreated` listener may return a
  cleanup, which runs right after `store.close()`.

**The removal slots** (`runs/removal-slots.ts`). Three slots in one process-wide registry: a
deletion gate `refuse(runId, kind, dataDir)`, a reclaim preparation
`prepare(run, { repoRoot, store })` and a removal cleanup `removed(runId, dataDir)`. Each slot gets
what it needs as a parameter; nothing is bound in hiding. The kinds are `history`, `worktree`,
`archive-tmp` and `scratch`. `registerBuiltInRunSlots()` (`built-in-run-slots.ts`, a `shell`
file) fills and seals the registry. Each process entry calls it beside `registerBuiltInRunners()`.

- Fail closed: deletion, reclaim, family archive, worker family end, worker admission, the terminal
  scratch reap and the startup orphan sweep each throw before their first side effect in a process
  that never sealed the registry.
- Preview has no slot. `ReclaimOptions.previewHost` is typed `{ release(runId): Promise<void> }`;
  the release runs after the clean and HEAD-reachable checks and never blocks a removal.
- A feature-owned store topic registers through `runs/worker-executions-registry.ts`: one factory
  per process, registered inside `registerBuiltInRunSlots()`, built on first use as
  `store.workerExecutions`, and failing closed before any side effect. It is not a fourth slot.

**The ports** (`runs/ports.ts`). Each port is an interface whose members are `RunStore` method
types (`RunStore['getRun']`) or written signatures of the topic that implements them. A caller
takes a port, an intersection of ports, or a `Pick` of one port. `runs/ports-guard.test.ts` refuses
`Pick`, `Partial`, `Omit`, `Required` and `Readonly` of `RunStore`, in any non-test file. It also
refuses `RunStore[…]`, `import('…').RunStore` included, outside `runs/store.ts` and
`runs/ports.ts`. The spec's table names the ports; `TranscriptFactsPort`, `RunLookup`, `RunPins`,
`LiveRunReads`, `RunArchive`, `RunMarkerRefs`, `RunRedaction`, `RunCompletionActions`,
`RunReadFlags`, `RunClaims`, `RunPersistence`, `RunRepoHandle`, `WorkerExecutionRecords` and
`WorkerScopeControl` arrived during the work.

**Topics leave the class.** Each topic is one module built from a narrow state object and exposed
as a store field: `store.eventLog`, `store.redaction`, `store.transcriptFacts`, `store.retention`,
`store.archive`, `store.readFlags`, `store.workerResults`, `store.workerExecutions`,
`store.claims`, `store.runPins`, `store.persistence`, `store.queries`, `store.repoScope`. A caller
uses the field or takes the port. `RunStore` has no forwarding method. What stays on the class:
`getRun`, `isUnreadable`, the `RunWrites` commits, the inbox input methods, `liveReadSnapshot`, the
private `change()`, the constructors `open` and `unavailable` (with the private `openOnce`), the
`unavailable` getter and `close`.

**Test rules.** A test never asserts inside a lifecycle handler, because the lifecycle swallows
the throw; it records, then asserts after the write. `runs/lifecycle-assertion-guard.test.ts`
refuses an `expect` in a handler. Tests seal the slots and register the worker executions through
shared testkits (`runs/removal-slots.testkit.ts`, `built-in-run-slots.testkit.ts`,
`delegation/worker-executions.testkit.ts`), with no global setup. `runs/emitter-guard.test.ts`
refuses `on`, `once`, `off`, `addListener`, `removeListener`, `prependListener` and `emit` with
`run`, `deleted`, `event` or `closed` in a non-test file outside `runs/`.

## Changed moments

Each change below stays within owner decision 1; the planner or the plan accepted it:

| Slice | Before | After |
| --- | --- | --- |
| A2, webhooks ([ADR 0050](0050-deliver-opted-in-webhooks-as-a-best-effort-lifecycle-subscriber.md)) | A `seen` map. (a) A run deleted here and restored by another writer's row sent `task.subscribed`. (b) A run first seen through another writer sent `task.subscribed`. (c) An exit applied at load caused a late `task.status` | The webhook subscribes to `run.created` and `run.updated`. (a) Sends nothing. (b) Sends `task.status` only if the derived state changed. (c) Sends nothing |
| B1, reports index | A `live` set | Settlement reads `run.status-changed`. An exit applied at load or adoption, and a conflict on a fallback run with no staged copy, lose the immediate settlement scan; the reports-dirty mark still rescans |
| B3, family reconciler | A throw stopped the other listeners and reached the writer | Logged; the other listeners and the write go on |
| C1, plain-run delete | Autosave cleared before the commit; a cleanup failure was silent | Autosave cleared in the cleanup after the commit; a cleanup failure is logged |
| D3, scratch | The sweep and the reap asked no gate | Both assert the seal at entry and ask the `scratch` gate; unsealed, both throw before any side effect |

## Consequences

`runs/` imports no feature: `layer-import.baseline.json` went from 17 `runs/` entries to 0.
`runs/store.ts` went from 3,381 lines to 990 and left `file-length.baseline.json`; the default
1,000-line limit guards it. Listener files on the store emitter went from 12 to 0, and test files
from 43 to 0. `Pick<RunStore` went from 41 sites to 0; the wider pattern
`Pick<RunStore|Partial<RunStore|Parameters<RunStore` went from 79 matches in 52 files to
`runs/store.ts` only.

The ports did not narrow test selection. Squeal selected 895 test files for `runs/store.ts` at
`8ff2e7b13` and 889 at `0d92ba360`, because most tests still build the store through testkits. A
port lowers the count only when the fixtures build only the ports a test uses (roadmap rule 5).

Two seams stay open:

- `delegation/removal-slot.ts` casts `ReclaimContext.store` to `RunStore` for
  `collectWorkerEvidence` (hearsay-tools/squawk#4091).
- For a conflicting row the store does not hold, `handleConflicts` takes `before` from the staged
  record, a write that never committed. Fixing it changes a published payload, so it waits for a
  decision (hearsay-tools/squawk#4092).

[ADR 0053](0053-keep-runmanager-a-facade-over-run-modules.md) was the model for moving topics one
at a time. Unlike `RunManager`, the store keeps no forwarding method: a forwarding facade over
about 213 methods could not reach 1,000 lines (owner decision 3).

Implementation and reader rules: [runs store area](../areas/runs-store.md),
[real-time events](../areas/realtime-events.md), the spec's
[implementation record](../../.ai/specs/2026-11-21-run-lifecycle-and-store-ports.md#implementation-record).

Coverage under `packages/cezar/src/`: `runs/lifecycle.test.ts`, `runs/removal-slots.test.ts`,
`runs/removal-slots-unsealed.test.ts`, `index-run-slots.test.ts`, `run-slot-entries.test.ts`,
`runs/emitter-guard.test.ts`, `runs/ports-guard.test.ts`,
`runs/lifecycle-assertion-guard.test.ts`, `delegation/worker-sidecars-compat.test.ts`,
`runs/run-persistence-saved-runs.test.ts` and `runs/webhook.test.ts`.
