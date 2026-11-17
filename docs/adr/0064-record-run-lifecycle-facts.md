# Record run lifecycle facts and derive states from them

A run lifecycle decision reads a **fact**: a named record that its one **owner** writes at the
moment the thing happens. The code does not record a proxy and infer the state later. Seven
facts are named:

| Fact | Lives in | Owner (only writer) |
| --- | --- | --- |
| `workflowCursor`: the next workflow step and whether it resumes or starts | run row | the exits' `fields()` in `runs/run-exits.ts` |
| `continuesStepId`: the step a synthetic `continue-N` step continues | step record | `workflows/continuation-admission.ts` |
| `parkReason`: why a waiting run parked (`turn`, `hold`, `closing-wakes`) | run row | the exits' `fields()` in `runs/run-exits.ts` |
| `doneAccepted`: an accepted `cezar_done` and how it was retired | run row, through `commitOutcome` | `run/run-finish.ts` writes it; `run/turn-settler.ts` retires it |
| Human wait to `askSeq` binding: which question a human wait belongs to | wait row | `run/human-waits.ts` |
| `deliveryAttempt`: input handed to the transport in one session, and its outcome | per-run memory | `run/input-delivery.ts` |
| `nudge`: a nudge sent in one session (`refused`, `submitted`, `acknowledged`) | per-run memory | `run/turn-nudges.ts` |

Facts that a restart must see are durable. `deliveryAttempt` and `nudge` are scoped to one
session: a restart opens a new session, an attempt in a dead session has no reader, and the
durable failure count (`waitDeliveryFailures`) already survives. A durable write per input would
add a database write for no reader.

Per-run memory that outlives one execution has one owner, `RunMemory`
(`workflows/run/run-memory.ts`). It opens a slot at run start and releases it at a final exit,
on delete and on `dispose`. State that a settlement still compares after disposal, such as the
continuation generation token, stays with its owner until that settlement drains. Each liveness
bound has one timer owner, `LivenessTimers` (`workflows/run/liveness-timers.ts`), with one typed
row per bound kind, so a new bound kind fails typecheck until its row exists. Clearing an
execution's or a run's timers is one call.

## Context

A review of the 619 issues labelled `bug` on 2026-11-15 found about 35 lifecycle bugs, and most
share one cause. The park notice read the execution phase `complete` as "finished", but recovery
writes `complete` for a parked worker (hearsay-tools/squawk#3502). A failed-wake charge read
"something is owed", not "a delivery was attempted" (hearsay-tools/squawk#1289). An accepted done
lived in turn-local state, so a queued input consumed it (hearsay-tools/squawk#2587). The workflow
position was derived from per-step statuses (hearsay-tools/squawk#1621). Per-run maps had no owner
that cleared them at run end (hearsay-tools/squawk#2064).

## Consequences

ADR 0053, ADR 0056 and ADR 0061 still hold. `RunManager` stays the facade. The run store applies
every status write through an exit, and `workflowCursor` and `parkReason` are exit fields, so the
store stays their single writer. Wait deadlines stay with the wait engine; `LivenessTimers` holds
the bounds that are not wait rows.

oxlint AST rules refuse a new write outside the owner, as the `cez/active-run-*-write-outside-owner`
AST rules do: `run-fact-write-outside-owner` for the fact fields, `liveness-timer-outside-owner` for
timers in `workflows/run/`, and `run-memory-field-outside-owner` for new per-run maps. Each named
exception carries its reason in the rule's `ignores`.

Saved runs stay readable. A saved row with `workflowResumeStepId` is read as a `workflowCursor`
with mode `resume`. A saved synthetic step without `continuesStepId` keeps the rule from before
this record.

Implementation: [2026-11-15-run-lifecycle-facts.md](../../.ai/specs/2026-11-15-run-lifecycle-facts.md),
epic hearsay-tools/squawk#3643.

Coverage: each slice in the spec names its tests; the rules are covered by
[ast-grep-rules.test.ts](../../packages/cezar/src/ast-grep-rules.test.ts).
