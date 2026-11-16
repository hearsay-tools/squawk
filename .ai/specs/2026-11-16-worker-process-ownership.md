# Worker process ownership (hearsay-tools/squawk#2180)
Status: active

Slice A (interface, Linux `cgroup`, `groups`, scan removal) shipped in hearsay-tools/squawk#3698. Slice B (the Windows `job` backend) follows it. Slices B
(Windows Job Object backend, shared with hearsay-tools/squawk#1876), C (native macOS checks) and
D (before/after spawn and destroy timings) follow as their own pull requests.

The rule and the lifecycle are in [ADR 0032](../../docs/adr/0032-prove-process-and-workspace-ownership-before-cleanup.md).
This spec keeps the product decisions and the case tables.

## Product decisions (owner, 2026-11-16)

1. Linux without cgroup delegation → the `groups` backend; diagnostics state the weaker guarantee.
2. A process outside the worker's scope that works in its worktree or scratch → ignored and never
   signalled; destroy removes the worktree anyway. On Windows an open handle makes the removal
   fail; destroy names the path and retries.
3. Workers created before scopes → their recorded session groups join the scope; no second path.
4. Windows (slice B): the worker's processes end with the controller, because its job closes.
5. Only workers get a scope; root tasks keep their session process groups.
6. Continue after a controller crash, with old processes still in the scope → Continue stops the
   scope, then starts the new execution.

No runtime fallback between backends: a backend error fails the operation that met it.

## Process exits

Behavior at shipped defaults. "Contained" is the `cgroup` backend; "scoped" is `groups`.

| Case | What stops it | Behavior |
| --- | --- | --- |
| Normal destroy, live leader | `scopes.stop` after teardown and termination | Contained and scoped: every process in the scope ends; the cgroup is removed |
| Leader exited first, member left in its group | the session reap at leader exit while the controller runs; else `scopes.stop` | Contained: ended. Scoped: reaped at leader exit by the controller that started it; after a crash, killed by destroy on Linux when its token is from this boot, left alone on another boot or on macOS |
| Detached descendant (`setsid`, Node `detached`) | `scopes.stop` | Contained: ended. Scoped: survives (accepted limit); `worktreeTeardown` is the way to stop such a service |
| Controller SIGINT/SIGTERM | session groups get the signal (`forwardToSessionGroups`) | Unchanged; the scope stays recorded for the next destroy or Continue |
| Controller SIGKILL before a cgroup is created | — | The record names the cgroup first; `stop` treats a missing cgroup as empty |
| Controller SIGKILL after placement, before the command `exec`s | the next destroy or Continue | The shell is in the cgroup; `kill` ends it |
| Placement fails (cgroup removed, permission lost) | the wrapper shell | `echo` fails, the shell exits non-zero, the command never runs; the spawn reports a failed start |
| Destroy races a launch | destroy intent, then `stop` | From the persisted intent `spawnScope` throws; a process that placed itself before the intent but after the kill makes `rmdir` fail with EBUSY and is killed in the next round; a removed cgroup accepts no member |
| Continue with worker services still alive | — | The scope is reused; services keep running |
| Continue after a controller crash, old processes alive | `stopCrashedGeneration` → `scopes.kill` | Old processes end, the old generation settles, the new one starts (decision 6) |
| Recovery settled the crashed generation first (sessions gone, a service still in the scope) | the checkpoint's `interrupted` mark, then `scopes.kill` on Continue | The service ends before the new execution starts |
| Normal finish, service left running, then Continue | — | The service keeps running in the reused scope |
| Retention or family end reclaims a settled worker's worktree while its scope holds a service | — | Refused until the scope is empty; destroy stops it |
| More live groups than the record cap (64) | the spawn site | The new start is refused and its process ended; no recorded live group is dropped |
| Another live Squawk controls the worker | — | Continue and destroy refuse; nothing is signalled |
| Scope record absent | — | Treated as empty; a worker from before scopes still has its execution record's groups |
| Scope record unreadable, oversized, wrong mode or another worker's | — | Spawn refuses; destroy stays incomplete with `process` remaining; nothing is signalled |
| Recorded group whose leader pid now belongs to another incarnation, or whose leader is gone and whose token is not from this boot | — | Not signalled |
| Outside process with its cwd in the worktree | — | Never signalled; the worktree is removed (POSIX). It keeps a deleted cwd |
| Scratch with a process still in the scope | scratch cleanup | Retained until the scope is empty |
| cgroup does not empty before the timeout | — | Destroy incomplete, `process` remaining, the cgroup stays recorded for the retry |
| Windows: controller ends (crash or exit) | the keeper's stdin closes, the keeper exits, the job's last handle closes | Every process of the worker ends (decision 4); the next destroy finds the job gone and completes |
| Windows: a command starts before its keeper created the job | `windows-worker-job.ps1 run` waits up to 30 s for the job | It starts inside the job once it exists; if the job never appears the command never runs and the start fails |
| Windows: a descendant outlives the session leader | `scopes.stop` → `TerminateJobObject` | Ended: it joined the job at creation |
| Restart or reboot after the destroy intent | the destroy retry timer | Same path from the start; each step is safe to repeat; after a reboot the cgroups and groups are gone |

## Worktree cases

| Case | Files written, kept or removed | State at the next step, Continue and restart |
| --- | --- | --- |
| Git admin entry and `.git` pointer gone, files remain | Unchanged from before this change: targeted removal of the recorded path, then the exact branch | Destroy completes |
| Checkout absent, registration remains | Unchanged: targeted `git worktree remove --force`, then the exact branch | Destroy completes |
| Removal refused by the OS (Windows open handle) | Kept; the refusal names the path and Git's reason | Retried with backoff |

## Measurements (slice D)

`packages/cezar/scripts/benchmark-worker-lifecycle.ts` (with `benchmark-project.ts` beside it), run
unchanged on `588275223` (main just before hearsay-tools/squawk#3698) and `3f1044ebb` (main with slices
A and B, plus this benchmark), alternating, on the coding host (24 cores, Linux, cgroup delegation
present, one-minute load 20-23, Node 26.13.0). Each run: 10 owned workers through `createOwnedRun` +
`enqueueOwnedRun` with the dry-run Claude mock, then `destroyForHuman` on 5 settled workers as they are
and on 5 with an unrelated `sleep` working in the worktree. Every attempt is counted: each spawn's
outcome, and each destroy's result. Times in milliseconds.

### End to end

| Run | Spawn outcomes | Spawn → session (median / p90) | Spawn → first turn ended (median) | Destroy, clean (median) | Destroy, outside process in the worktree (median) |
| --- | --- | --- | --- | --- | --- |
| before-1 | 10/10 settled `waiting` | 301 / 530 | 416 | 438, 5/5 complete | 348, **5/5 incomplete** |
| before-2 | 10/10 settled `waiting` | 292 / 477 | 411 | 426, 5/5 complete | 354, **5/5 incomplete** |
| after-1 | 10/10 settled `waiting` | 313 / 488 | 452 | 413, 5/5 complete | 439, 5/5 complete |
| after-2 | 10/10 settled `waiting` | 278 / 594 | 402 | 525, 5/5 complete | 463, 5/5 complete |

Spawn and clean destroy latency do not change beyond run-to-run noise at this load. The difference is
the outcome: before, an outside process in the worktree left every destroy `incomplete`, and in
production such a destroy keeps retrying until a human ends the process (the friction digests recorded
retries over hours). After, the destroy completes and the outside process is left running. No spawn
timed out or failed on either ref.

### Fixtures (primitives, apart from the end-to-end numbers)

| Ref | Primitive | Median | p90 | Failures |
| --- | --- | --- | --- | --- |
| before | `inspectGeneration` host-wide cwd scan, 479-485 host processes | 3.6-3.8 ms | 4.8-5.7 ms | — |
| after | `scopes.stop` of a cgroup holding a `setsid` descendant (kill, wait empty, remove) | 13.2-13.8 ms | 14.3-15.0 ms | 0 of 20 |

The scan's cost grows with every process on the host and was paid by every destroy attempt and
admission; a scope stop's cost is bounded by the worker's own processes. The scan is cheap on this
host's ~480 processes; the reviewed hearsay-tools/cezarion#1973 design exhausted its scan budget in CI,
which this design removes rather than tunes. The scope-stop fixture runs only on a containing backend
(`cgroup`, `job`); a `groups` host records why it skipped it.
