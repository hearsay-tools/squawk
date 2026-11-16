# Record run lifecycle facts and derive states from them
Status: active

## Goal

Every run lifecycle decision reads a named fact that one owner records when the thing happens.
Per-run memory and liveness bounds each get one owner. Lint rules keep new writes with the owner.
The 12 open lifecycle bugs of epic hearsay-tools/squawk#3643 close through these facts, each with a
test that fails on the code before its fix. [ADR 0064](../../docs/adr/0064-record-run-lifecycle-facts.md)
records the decision.

## Evidence

Read at main `14941f4c7` (2026-11-15). Every child issue is still live there.

| Issue | Proxy read today | Where |
| --- | --- | --- |
| hearsay-tools/squawk#3502 | Execution phase `complete` read as "finished". Recovery (`settleOrphanWorkerGenerations`) writes `complete` for a parked worker before the notice sweep runs | `workflows/run/worker-questions.ts` `parkedBeforeFinishing`, `workflows/run/run-recovery.ts` |
| hearsay-tools/squawk#1621 | Workflow position derived from per-step statuses. After `fail-start`, no step is running or waiting, so a Continue's done settles the run with steps pending | `launch-read-resolver.ts` `waitingWorkflowStepIndex`, `run-settlement.ts` `settleResumedWorkflowStep` |
| hearsay-tools/squawk#3024 | A synthetic `continue-N` step records no step it continues; the fallback is the chain's last agent step | `delegation/execution-identity.ts` `continuationDefStep` |
| hearsay-tools/squawk#2587 | Accepted done in turn-local `doneRequested`/`doneAtBoundary`; delivery and runner activity clear it | `run-finish.ts` `acceptDone`, `turn-settler.ts` `takeDoneRequest`, `turn-boundary.ts` |
| hearsay-tools/squawk#1293 | "Any open human wait" reused for a new native question | `human-waits.ts` `openHumanAlias`, `markHumanWaitSurfaced` |
| hearsay-tools/squawk#2444 | In-memory `pendingHumanAsk` set after the discard that can signal input readiness | `turn-settler.ts` `endTurn`, `core/cursor-print-runner.ts` `discardQueuedMessages` |
| hearsay-tools/squawk#1289 | "Something is owed" at idle close charges a failed wake | `wake-admission.ts` `failedWakeDelivery`, `run-settlement.ts`, `step-loop.ts` |
| hearsay-tools/squawk#3508 | Any rejected acknowledgement latches a step failure, also after the session closed | `input-delivery.ts` `latchInputFault` |
| hearsay-tools/squawk#1239 | An acknowledgement moves `resume` whether or not its turn ended | `input-delivery.ts` acknowledgement handler, `wake-admission.ts` `spendWakeAdmission` |
| hearsay-tools/squawk#2452 | `autonomousNudgePending` flag, bounded only by the idle timer, with no test that reaches the refusal | `turn-nudges.ts` `tryAutonomousNudge`, `turn-settler.ts`, `input-delivery.ts` |
| hearsay-tools/squawk#2443 | A submitted autonomous nudge has no reply or acknowledgement bound | `turn-nudges.ts` `tryAutonomousNudge` |
| hearsay-tools/squawk#2064 | Per-run maps with no owner that clears them at run end | `queued-input.ts`, `attachment-writer.ts`, `continuation-acceptance.ts`, `wake-retries.ts`, `worker-executions.ts`, `run-line.ts` |

No acknowledgement bound exists today, and about ten sites clear the idle timer.

## Product decisions

Accepted at the design gate on 2026-11-15:

1. Done accepted, then input arrives (hearsay-tools/squawk#2587). Input already pending when the
   agent calls `cezar_done` refuses the call with `input_pending`, listing what is owed. Input
   that arrives after acceptance keeps the done: it is delivered with a note, and the run finishes
   at that turn's end unless the agent registers a wait or asks. That turn costs no wake budget. A
   new human message, a new agent instruction or a failed wait result cancels the done.
2. A worker on an auto-resume hold gets no park notice (hearsay-tools/squawk#3502). A worker that
   parked by its own turn gets one, also after a crash or an idle close.
3. An autonomous nudge with no acknowledgement and no reply (hearsay-tools/squawk#2443) is bounded
   at 5 minutes, as the no-wait nudge. On expiry the run records a note naming the nudge and closes
   through the idle path, with no Needs You.
4. A clean session close that aborts an acknowledgement in flight (hearsay-tools/squawk#3508) is a
   retryable closed-session delivery failure: the input is requeued, and the 3-attempt cap holds.

## Plan

### Facts

| Fact | Shape | Lives in | Owner | Readers |
| --- | --- | --- | --- | --- |
| `workflowCursor` | `{ stepId: string; mode: 'resume' \| 'start' }` | run row (`contract/src/runs.ts`) | exit `fields()` in `runs/run-exits.ts` | `waitingWorkflowStepIndex`, `queuedStartAt`, `heldWorkflowStepId`, continuation settlement |
| `continuesStepId` | `string`, on a step with `synthetic: 'continuation'` | step record | `workflows/continuation-admission.ts` | `continuationDefStep` (identity only; `workflowCursor` and the status rules decide the position) |
| `parkReason` | `'turn' \| 'hold' \| 'closing-wakes'` | run row | exit `fields()` in `runs/run-exits.ts` | `parkedBeforeFinishing` |
| `doneAccepted` | `{ session: string; at: string; summary?: string }`, retired as `completed` or `reconsidered` with a reason | run row, through `commitOutcome` | `run-finish.ts` writes, `turn-settler.ts` retires | `decideWithoutDone`, the budget human wait, `acceptDone` |
| human wait `askSeq` | the existing wait-row field, now binding | wait row | `human-waits.ts` | `openHumanAlias`, the `answered` outcome, the input flush gate |
| `deliveryAttempt` | `{ session; inputIds; outcome?: 'acknowledged' \| 'closed' \| 'failed' }` | `InputGroup` (memory) | `input-delivery.ts` | `failedWakeDelivery`, the close paths, the acknowledgement handler |
| `nudge` | `{ session; cause: 'autonomous' \| 'no-wait' \| 'completion'; state: 'refused' \| 'submitted' \| 'acknowledged' }` | `BoundaryGroup` (memory) | `turn-nudges.ts` | turn settlement, readiness retry, idle settle |

`park` and `park-release` record `parkReason: 'turn'`; a session that closes while the run holds
wakes parks through its own exit, `park-closing-wakes`, which records `closing-wakes`; `hold` and
`hold-failure` record `hold`. A park of a run already `waiting` keeps the reason it parked for, so
an idle close or a restart keeps a turn's `turn`. A saved row without `parkReason` reads as `hold`
when it is a usage-limit hold, else as `turn`.

`workflowCursor` replaces `workflowResumeStepId`. A saved row with `workflowResumeStepId` is read
as `{ stepId, mode: 'resume' }` at load. `nudge` replaces `autonomousNudgePending`. `doneAccepted`
replaces `doneRequested` and `doneAtBoundary` as the done record; the boundary keeps read views.

### Owners

`RunMemory` (`workflows/run/run-memory.ts`) holds one slot per run with `#private` fields:
`deferredMessages`, `queuedImageSeq`, `retainedNotes`, `stoppedWorkers`, `memoryPausing`,
`lastNamerKey` and `forceStarted` move into it. The slot opens at run start and is
released at a final exit with no open wait and no auto-resume hold, on delete and on `dispose`.
These stay where they are, with a comment at the field: the `RunLine` scheduler indexes (ordered
and counted by `busySlots` and `pump`; `release` calls `line.forget`), `executions`,
`finalizedWorkers` and the orphan maps (their lifetime is a worker generation), the wait-engine
and wait-registry maps (keyed by wait id, ADR 0061), `reclaiming` and `autosaveTasks` (cleanup
evidence that outlives an execution), and `continuationGenerations` in `continuation-acceptance.ts`.
`RunSettlement.successSuperseded` compares that token after its diff and config I/O, also for an
accepted Finish that survives disposal, so the token must outlive `dispose` until pending
settlements drain. The timer maps in `wake-retries.ts`, `auto-resume.ts` and `inbox-claims.ts`
stay until S5 moves them into `LivenessTimers`: S4 lists them as named exceptions of its rule, and
S5 removes those exceptions.

`LivenessTimers` (`workflows/run/liveness-timers.ts`) has one row per bound kind: idle close,
nudge reply, acknowledgement, unread input, held human input, wake retry, wake backoff,
auto-resume, subagent grace, a native ask's subagent hold, subagent retry, inbox claim and request
deadline. Each row names its
scope (`execution` or `run`). `arm` replaces an existing handle for the same kind, run and key;
an expiry runs only while its handle is current and its session still matches.
`clearScope(run, 'execution')` runs at `dropActive`; `clearScope(run, 'run')` runs at release.
The `arm*` methods stay as thin callers, so the stack-frame timer selectors in tests keep working.
Wait deadlines and checkpoint retries stay in the wait engine. The orphan reprobe, the autosave
interval and the manager intervals stay where they are.

### Lint rules

| Rule | Refuses | Allowed |
| --- | --- | --- |
| `run-fact-write-outside-owner` | an object key or assignment of `workflowCursor`, `continuesStepId`, `parkReason` or `doneAccepted` | each fact's owner, under `ignores` with a reason |
| `liveness-timer-outside-owner` | `setTimeout`/`setInterval` in `workflows/run/**` and `workflows/run.ts` | `liveness-timers.ts`; the wait engine, `worker-orphans.ts`, `worktree-autosave.ts` and local awaited pauses, each with a reason |
| `run-memory-field-outside-owner` | a class field initialised with `new Map`, `new Set` or `new WeakMap` in the same files | `run-memory.ts`; each kept map's file, with the reason from Owners |

`deliveryAttempt` and `nudge` are `#private` fields of their groups, so the generated
`active-run-input-write-outside-owner` and `active-run-boundary-write-outside-owner` rules cover
them once their names join the group metadata in `scripts/active-run-owner-rules.mjs`.

### Slices

One pull request per slice. Each slice proves its regression test red on the commit before its
fix, recorded as `proof_base`, and adds a `RUNNER_IDS` parity cell where its issue asks for one.

| Slice | Closes | Change | Needs |
| --- | --- | --- | --- |
| S0 | (none) | This spec and ADR 0064 | none |
| S1 | hearsay-tools/squawk#1621 | `workflowCursor`; the read-time upgrade; Continue on a failed run with a `start` cursor queues the remaining steps after the repair Continue completes | S0 |
| S2 | hearsay-tools/squawk#3024 | `continuesStepId`; the `AGENT_PROTOCOL.md` §7 row | S1 |
| S3 | hearsay-tools/squawk#3502 | `parkReason`; the notice reads it; the live-controller opt-in goes | S0 |
| S4 | hearsay-tools/squawk#2064 | `RunMemory`; `run-memory-field-outside-owner` | S0 |
| S5 | hearsay-tools/squawk#3662 | `LivenessTimers`; `liveness-timer-outside-owner`; no behaviour change | S0 |
| S6 | hearsay-tools/squawk#1293 | `askSeq` binding; `answered` settles waits up to its `askSeq` | S0 |
| S7 | hearsay-tools/squawk#2444 | the input flush gate reads the open human wait; prepare before discard | S6 |
| S8 | hearsay-tools/squawk#1289 | `deliveryAttempt`; both close paths charge only an attempted delivery; `run-fact-write-outside-owner` | S0 |
| S9 | hearsay-tools/squawk#3508 | an abort after close records `closed` and requeues; `refusalDeliveryBound` requires the cap failure | S8 |
| S10 | hearsay-tools/squawk#1239 | an acknowledgement after its turn ended checkpoints without `resume` | S9 |
| S11 | hearsay-tools/squawk#2452 | `nudge` replaces `autonomousNudgePending`; A13/A14 run on the OpenCode wire through a real refusal | S5 |
| S12 | hearsay-tools/squawk#2443 | the acknowledgement and reply bound for a submitted autonomous nudge | S5, S11 |
| S13 | hearsay-tools/squawk#2587 | `doneAccepted` and the completion protocol | S7, S8 |

Waves: S1, S3, S4 and S6 first; then S2, S5, S7 and S8; then S9, S10 and S11; then S12 and S13.
At most four run at once. Slices in one wave can share a file, so they merge in a fixed order and
each later slice merges `main` before its PR: S1 before S3 (both change `runs/run-exits.ts`), and
S5 before S7 before S8 (all change `run/input-delivery.ts`).

## Case tables

### Transitions out: hearsay-tools/squawk#1621 (S1)

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| queued, cursor `start` at step N | worktree setup fails | step loop, `fail-start` | `failed`; the cursor stays at step N |
| failed, cursor `start` at step N | Continue | the user | a synthetic continuation runs (repair session); the cursor stays |
| running (repair continuation), cursor `start` at step N | accepted `cezar_done`, turn end | the agent | `requeue`; step N starts; steps before N do not replay |
| running (repair continuation), cursor `start` at step N | setup fails again | step loop, `fail-start` | `failed`; the cursor stays |
| failed, cursor `start` at step N | Finish | the user | the run settles as Finish does today; Finish stays explicit |
| failed, cursor at step N | restart, no live session | recovery | the cursor is read from the row; the next Continue behaves as above |
| failed, saved row without a cursor | Continue | the user | today's status derivation decides |
| running, last workflow step | accepted done, turn end | the agent | `succeed`; the cursor is cleared |

### Transitions out: hearsay-tools/squawk#2587 (S13)

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| running, input pending | `cezar_done` | the agent | refused with `input_pending`; no record |
| running, nothing pending | `cezar_done` | the agent | `doneAccepted` committed; the run finishes at turn end |
| running, `doneAccepted` | a resolved wait result or a non-instruction observation arrives before turn end | wait engine | delivered with the done note; `doneAccepted` stays |
| running, `doneAccepted`, delivery turn | turn end with no wait and no ask | the agent | `succeed`; the turn costs no wake budget, also at 40 of 40 |
| running, `doneAccepted` | a new human message, a new peer or worker instruction, or a failed wait result | the user, a peer, a worker, the wait engine | `doneAccepted` retired as `reconsidered`; the agent must call done again |
| running, `doneAccepted` | the agent registers a wait or asks | the agent | `doneAccepted` retired as `reconsidered`; the run parks as today |
| running, `doneAccepted` | the worker completion gate refuses | completion gate | refusal as today; `doneAccepted` retired as `reconsidered` |
| waiting, `doneAccepted` | restart, no live session | recovery | the committed record is read; the run finishes at the next turn end with no new wait or ask |
| any, `doneAccepted` | Finish, cancel, delete | the user | existing exits; the record goes with the run |

## Orders that must survive

- `turn-end.test.ts` pins input priority over done and budget priority over the no-wait reminder.
  S13 keeps input priority, and adds the `doneAccepted` row above the budget human wait.
- `turn-settler.test.ts` pins `humanWait, discard, …, prepareAsk`. S7 flips it, with a red proof.
- `run-recovery.ts` settles orphaned worker generations before it recovers worker messages. S3
  keeps that order and stops reading the phase.
- The stack-frame timer selectors (`armIdleTimer`, `armNoWaitNudgeReplyTimer`,
  `armHeldHumanInputTimer`, `armUnreadInputTimer`, `armGrace`) keep their frames through S5.

## Coordination

Coordinator task `ff8ddfa5`. Each slice runs in its own Squawk worker and worktree, works its
child issue with `/dev-flow`, gets a pre-PR review round, and merges in the order of the Slices
table.
