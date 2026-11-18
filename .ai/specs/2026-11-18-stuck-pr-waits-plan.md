# Wake PR waits on queued checks
Status: active

Implements hearsay-tools/squawk#3918. Coordinator approved the design on 2026-11-18.

## Design and preserved guarantees

A checks wait resolves as `stuck` only when a check run has been observed QUEUED for at least
15 minutes. No setting is required. The existing head guards, conflict
precedence, workflow-active suppression of terminal outcomes, deadlines, retries,
query permits, child ownership and activity progress remain in force. Merge waits
are unchanged. All settled checks still use the normal outcome.

The coordinator accepted an observed queue clock in place of the issue's
created_at design note after live API probes showed neither REST nor GraphQL
CheckRun provides created_at. Actions jobs require more requests or incremental
sampling, which the coordinator rejected. Existing gh checks, metadata and
workflow reads remain unchanged, including buckets and deduplication. A per-wait
clock keys each queued check by name and link; absent or non-QUEUED rows reset
that check's clock. First observation starts the clock even for an already-stuck
check. A cockpit restart restarts it. No timestamp is persisted.

During an active workflow the existing 30-second snapshot loop checks the age.
During gh --watch, a timer caps the phase at the earliest observed queued
time plus 15 minutes. The child is aborted and reaped before
the normal snapshot confirms current state. Metadata-only probes are unchanged.
No stale cached check state decides `stuck`. If a check becomes QUEUED only
while the native watch runs and no queued check was present at entry, its clock
starts at the next snapshot. Metadata-only probes and progress-only reads do not
start a clock or decide an outcome. That snapshot can be the watch's exit read.

## Transitions out

| State | Trigger | Who fires it | Default behavior |
| --- | --- | --- | --- |
| Queued | Watcher capacity available / deadline | Supervisor | Existing FIFO and original deadline |
| Running, checks wait | Check observed QUEUED for at least 15 minutes | Snapshot after both head guards | `stuck`, diagnostic and normal durable wake |
| Running, checks wait | QUEUED observed for less than 15 minutes | Snapshot / watch cap | Remain pending |
| Running, checks wait | Any age IN_PROGRESS / WAITING / REQUESTED / PENDING | Snapshot | Remain pending; no queued-age wake |
| Running, checks wait | All checks settle | Snapshot | Existing pass/fail/cancel/skip outcome when no active workflow |
| Running, checks wait | Head changes / conflict | Metadata | Existing head_changed / conflicting takes precedence |
| Running, checks wait | Watch cap reached; check started meanwhile | Timer then snapshot | Continue pending with current state |
| Running, merge wait | Any queued check | Merge supervisor | Unchanged; only merge semantics decide |
| Waiting / recovery without a live session | Stored result / restart | Wait engine | Existing persistence and wake delivery; accepts new enum value |
| Review / Done / Failed / Cancelled | No active checks wait | None | No new transition |
| Any active wait | Cancellation / deadline / query error | Existing supervisor authority | Existing outcomes; no deadline extension |

Wake text names sanitized check names and observed queued minutes and both clock limitations. It tells the agent to
close and reopen the PR to start fresh pull_request and pull_request_target runs on the same
head, and to push a new head only if the fresh run also stays queued. It never
suggests an empty commit. The diagnostic retains the contract's 4096-byte bound.

## Consumers

Contract enum, supervisor snapshots and watch timer, tool description, cockpit
outcome label, tests, HTTP and GitHub area docs. Wait-kind text serializes the
whole result including diagnostic; its non-success set already treats stuck as
non-success. Activity progress uses buckets and leaves the view after resolution.
