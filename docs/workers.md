# Owned workers

Every task has two settings, both on by default:

- **Allow Squawk workers**: the task's agent may start Squawk workers and resume them. Each worker is a separate paid agent session. The worker limits below cap resources, not spending.
- **Allow task messaging**: the task's agent may list, message and wait on other tasks in this project with `hsq message`.

Set them in the new-task form, in the task's header menu at any time, with `hsq task start` or `hsq run` and `--no-workers` / `--no-messaging`, or in an automation's `task.allowWorkers` / `task.allowMessaging`. A task created before these settings existed counts as on for both. The cockpit and headless `hsq run` start one private loopback listener; each eligible session receives the absolute bundled Node/CLI invocation and its own environment credentials. No `hsq` installation on the agent's PATH, config file, separate daemon, or remembered port is needed. If the listener cannot start, ordinary tasks keep working without delegation tools.

Turning **Allow Squawk workers** off refuses new `spawn` and `--resume` at once, including through a session's existing credential and for a spawn still waiting to be accepted. The task keeps messaging, waiting on, inspecting, collecting, stopping and destroying the workers it already has, and work already accepted finishes. Turning **Allow task messaging** off refuses peer discovery, new peer waits and new peer messages in both directions; a reply to a request accepted earlier still lands, and messages between a task and its own workers are never blocked. A root task with both off, no worker receipt and no open peer request gets no credential; worker sessions, and roots with a worker receipt (also a deleted worker's, so its retained result stays collectable) or an open peer request, keep theirs. Native subagents inside one session are not Squawk workers, and these settings do not change them. These settings are cooperative supervision, not process isolation.

`CEZ_DELEGATION` is retired and has no effect. A caller that set `CEZ_DELEGATION=1` needs no change. A caller that relied on it being unset turns the settings off per task, for example `hsq run --no-workers --no-messaging "<task>"`.

The provisioned command has these forms (the session instructions supply the absolute invocation):

```sh
hsq worker spawn --baseline parent-head --request-id <UUID> 'Implement the assigned change'
hsq worker spawn --baseline parent-head --request-id <UUID> --runner codex --effort high --context-file ./selected-context.txt 'Review the parser'
hsq worker spawn --baseline parent-head --request-id <UUID> --workflow review 'Review the parser change'
hsq worker spawn --workspace shared --request-id <UUID> 'Review the committed change; do not edit files'
hsq worker list                         # A root: its whole family. A worker: the workers it started. With revisions and cleanup resources (fetches pages automatically)
hsq worker inspect <worker-id>
hsq worker steer <worker-id> 'Consider this additional constraint'
hsq worker diff <worker-id>
hsq worker collect <worker-id>
hsq worker wait <worker-id> --mode one --timeout-seconds 600
hsq worker wait <first-id> <second-id> --mode any --timeout-seconds 600
hsq worker wait <first-id> <second-id> --mode all --timeout-seconds 600
hsq worker cancel-wait <wait-id>
hsq message request <recipient-run-id> 'Please check this decision' --id <message-UUID>
hsq worker resume <worker-id> 'Correct the returned result' --id <new-message-UUID> [--model <model>] [--effort <level>]
hsq message progress <recipient-run-id> 'Parser tests pass' --id <message-UUID>
hsq message follow-up <recipient-run-id> 'Include empty input' --id <message-UUID> --request-id <request-UUID>
hsq message reply <recipient-run-id> 'Checked; empty input is covered' --id <message-UUID> --request-id <request-UUID>
hsq message conversation <recipient-run-id>
hsq message wait --request <request-UUID> --request <another-request-UUID> --mode all
hsq message wait --peer <task-id> --timeout-seconds 1800   # Wake on that peer task's next message, or when it settles
hsq message inbox
hsq message tasks --all
hsq message cancel-wait <wait-id>
hsq message cancel-request <request-UUID>
hsq worker stop <worker-id>
hsq worker destroy <worker-id>
hsq worker destroy <worker-id> --discard-work   # Delete the work a plain destroy refused to delete
```

Use `hsq message --help` for messaging commands. Use `hsq worker --help` to list worker operations and flags, or `hsq worker <operation> --help` for one operation. Explicit help prints human-readable text and exits successfully without an active delegation session. Commands otherwise return bounded JSON and a nonzero exit on failure or incomplete cleanup. A spawn into an isolated workspace requires a committed baseline (`parent-head` or an explicit ref) and pins its SHA at acceptance; dirty parent edits are excluded. A spawn with `--workspace shared` takes no baseline ([Shared workspace](#shared-workspace)). Optional `--context '<text>'` or `--context-file <UTF-8-file>` supplies selected context, not the parent's conversation. The two flags are mutually exclusive, and combined task/context text is limited to 100,000 characters. The API also accepts up to 32 pinned-baseline file or parent-attachment references, with at most 8 MiB of copied attachments. Inspect reports worker-local input locations. Reuse a request ID only with the same task, baseline, context, runner, model, effort and workflow when retrying a lost response. `--runner` and its alias `--backend` count as the same field, so a retry may switch spelling. A parent holds at most 32 outstanding workers: accepted, live, or not yet verifiably destroyed. A verified destroy (`hsq worker destroy`, or **Clean up** on a finished worker in the cockpit's Workers list) frees a slot; incomplete cleanup keeps its slot until a retry completes. A worker that fails before its first step starts (for example, when its worktree cannot be made) holds no work, so Squawk destroys it by itself and frees its slot; `worker list` shows it as destroyed, and `collect` still reports its failure. When that failure leaves a worktree or branch Squawk cannot prove it made, the destroy stays incomplete, names what is left, and keeps the slot until you remove it and the next attempt completes. A parent can create at most 1,024 workers in total; past that, start a new task. These limits bound disk resources and runaway spawning, not spending: a worker can be resumed with Continue, and destroying it does not undo charges already made. Cost stays bounded by `maxParallel` and by stopping the parent. There are at most 32 undelivered steering messages per worker.

In this repository, read [Stacked and overlapping branches](areas/git-worktree.md#stacked-and-overlapping-branches) before you spawn a worker with another open pull request's head as its baseline, or two workers that edit one file. It gives the merge order and the `npm run restack` command for a branch whose base pull request was squash-merged.

A destroy deletes the worker's worktree and branch. It refuses to delete work: uncommitted changes in the worktree (staged, modified or untracked files; ignored files do not count), or commits on the worker branch, or only in its reflog, that no other branch or remote-tracking ref reaches. The refusal comes before the destroy starts, so the worker is not stopped and you can still resume or collect it. The answer is `incomplete` with exit 1, a `work` field with `uncommittedFiles` and `commits`, and an error that names both counts. Land or commit what you need and run destroy again, or run `hsq worker destroy <worker-id> --discard-work` to delete the work. Destroy checks again under the worktree lock after the worker stops, so work written after the first check refuses the same way. The pending destroy keeps the `--discard-work` approval, so its automatic retries delete the work too. The cockpit's **Clean up** refuses the same way and then offers **Discard work and clean up**. A worker without such work is destroyed without a question (hearsay-tools/squawk#3553).

Destroy and worker spawn share one worktree mutation lock per repository. An explicit destroy waits up to 30 seconds in its queue, less when stopping the worker already used part of a 40-second answer budget (never under 1 second); when the lock stays busy, the answer names the holder (its operation, task or worker id, and PID) and the time of the next automatic attempt. Stopping a worker can itself take up to 60 seconds, so the CLI's 45-second request bound can end first: the CLI then reports `unavailable_transport`, the destroy continues on the server, and `hsq worker inspect` shows its result. A worker's worktree creation waits 120 seconds plus 60 seconds for each claim queued ahead of it, at most 10 minutes; its `git worktree add` runs for at most 120 seconds, is retried once after its partial checkout is removed, and fails with Git's own error. An incomplete destroy reports the remaining resources and a reason that names the check that failed. Squawk retries that recorded request after a delay, including after the project's context recovers on server restart. It removes the owned checkout only after it has stopped the worker's processes and verified ownership. If the reason persists, read it, correct the blocker (a Git worktree lock, the ownership receipt, a process the worker started that would not stop) and use `hsq worker destroy <worker-id>` or the cockpit Destroy action to retry immediately. Squawk leaves ambiguous or replaced resources in place for operator review.

### Shared workspace

`hsq worker spawn --workspace shared` starts a worker in the directory its parent works in: the parent's worktree, or the repository root for a parent that runs in place. The default, `--workspace isolated`, gives the worker its own worktree and branch as before.

A shared worker starts at the parent's HEAD, and its record keeps that commit as `baselineSha`. With `--workspace shared`, `--baseline parent-head` is accepted and changes nothing, because that is the commit a shared worker starts at; any other `--baseline` value is refused. `--attach` is refused too: the file is already in the directory the worker runs in. Text context and baseline files work; Squawk copies each baseline file from its commit into the worker's own data directory, never into the parent's worktree, and `hsq worker inspect` reports those paths.

A shared worker has none of the things an isolated worker owns:

| An isolated worker has | A shared worker |
| --- | --- |
| Its own worktree and branch | Has neither. Its workspace record names the parent's directory (`path`) and the task whose directory it is (`hostRunId`) |
| Autosave commits | Never: Squawk commits nothing in the parent's worktree for it |
| `worktreeSetup` and `worktreeTeardown` commands, personal agent config copied in | Never run or copied |
| A diff (`hsq worker diff`, `diff` in the collected result) | None: `diff` is `unavailable` with reason `unsupported`. Read `changes` instead |
| Commit, push, pull request and worktree removal on its task page, and a preview | Not offered. The server refuses commit, push, pull request and removal with `this worker runs in its parent's worktree`, and starts no preview |
| A worktree and a branch that destroy removes, under the worktree mutation lock | Destroy stops its processes and ends with `remaining: []` and `deleted: []`. It takes no worktree mutation lock and touches no file or branch of the parent |

While a shared worker is queued, running, waiting or being destroyed, Squawk does not reclaim or remove the directory it works in: retention skips its host task, and the cockpit refuses to remove that task's worktree or delete its branch until the worker has ended or is cleaned up. The other direction holds too: while such a removal or reclaim runs, a Continue of the shared worker is refused and a queued one stays in the queue. The worker's own task page reads its files, changes and transcript file links from that directory.

Launch and Continue check that the recorded directory still exists and is a worktree of this repository. If it is not, the worker fails with the reason; Squawk creates nothing in its place.

**Change report.** Squawk records the directory's state when the shared worker's first session starts and again each time the worker settles: the HEAD commit, the checked-out branch (or a detached HEAD), the content of the index, tracked changes and untracked files. Ignored files are not part of it; that includes Squawk's own run files in a repository root, which the `.gitignore` in its data directory ignores. `hsq worker collect` returns the comparison as `changes`:

- `{ "state": "unchanged" }`: nothing in the record changed.
- `{ "state": "changed", "paths": [...], "truncated": false, "headMoved": false, "branchMoved": false, "indexMoved": false }`: `paths` lists at most 100 changed paths, and `truncated` says that more changed.
- `{ "state": "unavailable", "reason": "..." }`: Squawk could not record or read a state, for example because the worker never started a session.

The comparison always starts at the first session, also after a Continue or a restart. While the worker runs, `collect` compares with the directory as it is at that moment. A settled worker is compared only with the state recorded when it settled; when Squawk could not record that state, `changes` is `unavailable`, so a later edit is never reported as part of the worker's run. A worker whose session crashed with its controller has no change report: Squawk learns of its end only later, so `changes` is `unavailable` for it.

Squawk compares content, with these limits:

- A changed or untracked file of at most 8 MiB is compared by a hash of its content, up to 64 MiB of content for one recorded state. A file past either bound is compared by size, modification time and mode, so a same-size rewrite that restores the modification time does not show for it. Where both states hold the content hash, a change of the modification time alone does not show; a change of the executable bit does.
- Squawk reads content only inside the worker's directory and follows no link. A symbolic link is compared by its target path. A file under a directory that was replaced by a link to a place outside is compared by size, modification time and mode.
- The capture is not a security boundary. A directory that is swapped for a link while Squawk reads the state can make it hash a bounded number of bytes of another file; Squawk stores only the hash.
- A submodule, or another nested repository, is compared by its own HEAD, index, changes and untracked files, three levels deep; a deeper one by its HEAD only.
- A file that was changed and then changed back reads as unchanged.
- One recorded state keeps 5,000 changed or untracked paths with content. The rest are compared together by size, modification time and mode; a change among them reads as `changed` with `truncated: true` and no path.
- An end state belongs to one execution of the worker. After a Continue, the end state of the earlier execution is not used.

Squawk does not prevent a write, and the report does not say who made a change. **Two agents work in one worktree:** an edit, a commit or a checkout by the parent, by another shared worker or by a human during the worker's run shows as changed too. Give a shared worker a task that reads (a review, an analysis), and say in the task text when it may write. Its session prompt tells it that it shares the parent's worktree and must not write there unless its task says so. Do not change the same files in the parent while it runs.

A shared worker counts toward the same limits as any worker: 32 outstanding workers and 1,024 creations per parent.

### A worker that starts a worker

A worker that a root task started may start one worker of its own, for example to review its change before it reports. That worker always runs in a shared workspace, in the directory of the worker that started it.

```sh
hsq worker spawn --request-id <UUID> 'Review my last commit; do not edit files'
hsq worker wait <worker-id>
hsq worker collect <worker-id>
hsq worker destroy <worker-id>
```

- **No flag is needed.** A spawn that names no `--workspace` uses the first kind the caller may start: `isolated` for a root task, `shared` for a worker. `--workspace isolated` from a worker is refused, and the answer names the allowed kinds. `--attach` and a `--baseline` other than `parent-head` are refused as for every shared worker, so `hsq worker spawn --baseline parent-head ...` works from a root and from a worker alike.
- **One at a time.** A worker may have one outstanding worker. It destroys the finished one before it starts the next; destroy of a shared worker is immediate. A second spawn while the first is outstanding answers `capacity_limit` and says so. The worker that was started this way cannot start a worker.
- **The family stays flat.** The root task holds every receipt, every message and every limit: 32 outstanding workers and 1,024 creations count the workers of its workers too. Each worker record names its **supervisor**, the task that started it.
- **Messages follow the supervisor.** A worker and the worker it started message each other with `hsq message`; "your parent" in a worker's prompt is its supervisor. The root and a worker's worker cannot message each other. A worker that another worker started gets no question card: `cezar_ask` tells it to send a request message to its supervisor instead.
- **Waits and results follow the supervisor.** The supervisor waits on its worker, and the settlement wakes the supervisor, not the root. `hsq worker collect` stores the result on the root's record; the supervisor and the root can both read it. `hsq worker list` shows a worker the workers it started, and shows a root its whole family with each worker's `supervisorRunId`.
- **The same done gate.** A supervisor's first `cezar_done` with a live or uncollected worker is refused once with what to do. For a live worker, the second makes Squawk wait for it and wake the supervisor. An uncollected result needs `hsq worker collect`; a second done does not wake on it by itself. As for a root, the gate also holds the supervisor's open requests, and it keeps holding them after every worker the task started is destroyed or deleted: cancel a request you no longer need, or wait for its reply.
- **Endings.** A worker that fails, is cancelled, is stopped or is destroyed gets the live workers it started cancelled, because they work in its directory. A failed root still keeps the live workers of its family, and they continue. Destroy of a worker first stops and destroys the workers it started. A worker that another worker started continues only while that worker is live: after its supervisor settles in any way, failed included, continue the supervisor first.
- **What the root still controls.** The root task may inspect, wait on, collect, stop and destroy every worker of its family, so cleanup never depends on a worker that has ended. It does not steer or message a worker it did not start. The root task's **Allow Squawk workers** setting gates every spawn in its family.
- **History.** Delete the history of the workers a worker started before you delete that worker's history; the cockpit names them when it refuses.

### Run a review round from a worker

A worker reviews its own committed change before it pushes: it starts one worker that reads the commits, and it reads that worker's report. The project's pre-PR review rule names the runner, the model, the effort and the review prompt; [Continuous integration](sdlc/ci.md) says where that review stands among the gates.

1. Commit the change. Then start the worker with the command of the review rule and a new request id:

   ```sh
   hsq worker spawn --baseline parent-head --request-id <UUID> --runner <runner> --model <model> --effort <effort> --context-file <review-prompt> '<task>'
   ```

   The task text names the branch, the head SHA from `git rev-parse HEAD` and the base. It names the pull request when one exists; else it says that none exists yet. It says to read commits with `git show` and never check out, to change no file, and to send the full report to its parent and then call `cezar_done`. From a worker the command starts a shared-workspace worker in the caller's worktree, and `--baseline parent-head` changes nothing there ([A worker that starts a worker](#a-worker-that-starts-a-worker)).
2. Register the wait and end the turn. Do not edit the worktree while the round runs.

   ```sh
   hsq worker wait <worker-id> --mode one --timeout-seconds <1-7200>
   ```

   One round has a total time limit of one hour, counted from the spawn. The limit is a rule of this procedure, not a Squawk timeout: a wait never stops its worker. Give each wait a `--timeout-seconds` of at most the time left in the hour, and register the wait again after a wake on a message or a deadline. When the hour has passed and the worker has not settled, stop it, destroy it and count a failed round:

   ```sh
   hsq worker stop <worker-id>
   hsq worker destroy <worker-id>
   ```

3. Collect the result.

   ```sh
   hsq worker collect <worker-id>
   ```

   A round is valid only when all three hold:

   - **The worker has settled.** The result says `"settled": true` and `"partial": false`. A result of a running worker is partial, and its `changes` compares with the directory at that moment: wait again.
   - **The full report has arrived.** The worker sends it as a message to its parent before `cezar_done`. The collected `summary` holds at most the last assistant text, cut at 4,000 characters; it is not the report.
   - **`changes` says `unchanged`** ([Change report](#shared-workspace)). `changed` means that a file, the index, HEAD or the branch moved during the round: read `paths` and find the cause. `unavailable` means that Squawk has no comparison, for example after a crashed session.

   The round covers the head SHA that the task names: `git rev-parse HEAD` must still print it when the round ends. A worker that failed, was cancelled, or settled with no report, and a round whose `changes` is `changed` or `unavailable`, is a failed round: destroy the worker and run the round again.
4. Destroy the worker. A worker may have one outstanding worker, so the next round starts only after this.

   ```sh
   hsq worker destroy <worker-id>
   ```

After a fix, commit and run the next round on the fix only. When the spawn is refused (**Allow Squawk workers** is off for the task, the limit is reached, the runner is not available) or after two failed rounds, run the same prompt in a native subagent and say in the pull request body that the round ran that way.

### What destroy stops

Every process Squawk starts for a worker (its setup, agent sessions, `check` steps and preview server) starts inside the worker's **scope**, and destroy stops the scope ([ADR 0032](adr/0032-prove-process-and-workspace-ownership-before-cleanup.md)). `hsq worker inspect` reports it as `scope.backend` and `scope.guarantee`:

| Host | `scope.backend` | What destroy ends |
| --- | --- | --- |
| Linux where Squawk can create cgroups under its own (systemd user services usually allow it) | `cgroup` | Every process the worker started and every descendant, detached ones too (`guarantee: contained`) |
| Windows where Squawk can start a process inside a Job Object (a startup probe checks) | `job` | Every process the worker started and every descendant (`guarantee: contained`); the worker's processes also end when Squawk itself exits |
| macOS, and Linux without cgroup delegation | `groups` | The worker's own process groups while their leader runs. A descendant that left them (`setsid`, Node `detached`) can outlive destroy, and so can a member left in a group whose leader already exited, unless Squawk reaped it when that leader exited (`guarantee: scoped`; on Linux such a group is still ended when its record is from the current boot). Stop such a service with the project's `worktreeTeardown` commands, which destroy runs first |
| Windows where that probe fails | `groups` | Windows has no process groups: a session's process tree ends (`taskkill /T`) only while the session's own process still runs, and a descendant left after it exits can outlive destroy (`guarantee: scoped`). `worktreeTeardown` stops such a service |

A process that Squawk did not start for the worker, such as an editor or a shell opened in its worktree, is not the worker's: destroy neither waits for it nor signals it. On Linux and macOS it removes the worktree anyway. On Windows, a file such a process holds open stops the removal; destroy then reports `incomplete` with the path and retries after the process lets go.

`--workflow <name>` runs a catalog workflow inside the worker: the built-in `quick-task` or any `.ai/cezar/workflows/*.yaml` by name, with its agent and check steps, native `skill:` triggers and `onFail` loops, so a repo's `review.yaml` becomes a dedicated reviewer. Omitted `--workflow` runs `quick-task` exactly as before. `--runner`, `--model` and `--effort` fill only the steps that leave those fields unset; a step's own `allowedTools`/`bashAllowlist` narrow the parent's grants and never widen them. An unknown name is refused. Agent steps may mix runners: at spawn every agent step is resolved and pinned separately, so an implement-with-codex, review-with-claude chain runs each step under its own runner, account, model, effort and grants. A step's optional `agentProfile` names the account it runs under (an id the registry does not know is refused); same-runner steps otherwise inherit the parent's account and other runners resolve their project/default one. Run-level columns show the first agent step.

Explicit default-account model pins are checked against a fresh, nonempty host catalog after account/model resolution and before a worker is created. Named accounts retain existing validation because a default-account catalog cannot disprove their model access. A miss returns `invalid_input`, available models with advertised efforts, and other runners listing the requested ID in `modelChoices`. Empty, stale, or unavailable discovery leaves existing selection validation in place. Accepted retries and omitted model defaults are unchanged.

Omitted `--runner` inherits the parent's active runner. Same-runner workers inherit omitted model/account/effort; `--runner <claude|codex|opencode|pi|omp|antigravity>` selecting another runner resolves that runner's project/default account and model without forwarding another provider's settings. `--backend` is a permanent alias of `--runner`; giving both with different values is refused as `invalid_input`. Worker `inspect` and `collect` still report the selected runner in a field named `backend`. `--model <model>` selects a supported model, subject to existing locks. `--effort <low|medium|high|xhigh|max>` pins reasoning effort on same-runner and mixed-runner spawn; omitted `--effort` still inherits the parent pin on same-runner spawn and drops it on mixed-runner spawn. Accepted runner, account and grants remain fixed across queuing, restart and Continue, including explicit empty grants; a human Continue or supervisor `hsq worker resume` may override `model` and `effort` on the worker's existing runner (subject to model locks and host catalog checks). Changing or deleting an account registry entry does not rebind a worker. Missing accepted identity evidence or account homes, incompatible Claude state-file layouts, and conflicting later model locks refuse execution explicitly. Credentials and vendor configuration are never copied; each worker receives its own delegation credential, and unspecified native models stay unspecified.

Wait registers immediately. End the parent turn to release scheduler capacity; Squawk resumes it on a selected settled outcome or the finite deadline. `any` is the default, `one` requires exactly one worker, and `all` waits for every selected worker. Review, completion, failure, cancellation with proven termination, and destruction are outcomes. Timeout defaults to 600 seconds (1–7200 accepted). `cancel-wait` is idempotent for the retained wait ID and cannot cancel a newer wait. Empty dependency-deadline wakes do not spend the automatic-wake budget; explicit timers and native-subagent safety deadlines remain charged. Timeout and wait cancellation report partial outcomes and unresolved workers, never cancel workers, and never automatically re-wait. Steering is attributed agent input and cannot answer a pending human question.

Parents and owned workers can converse in both directions; a worker may address only its parent. `send --kind request` opens a reply obligation whose ID is the message ID; `send --kind progress` (or `progress`) does not. Follow-ups clarify an existing request; only an explicit correlated `reply` settles it as replied. Retry a message with the same ID and exact payload, including deadline duration; changed payloads are rejected. Acceptance, provider delivery, reply, and task completion are separate facts, visible in the task transcript and `conversation` JSON.

Messages allow 100,000 characters each, with at most 32 undelivered inputs per recipient, 1,024 active messages per family, and 32 pending requests. Settled history moves out of the active count, so it never blocks a send; a message or request ID stays findable at any age. Every send result and `hsq message tasks` carry `capacity`: `activeMessages` (with the room open requests reserve for their replies), `openRequests`, their limits, `inboxLimit`, and on a send the recipient's used inbox slots (`recipientInbox`). A `warning` names each bound at 75 % or more; at a limit, new messages are refused with `capacity_limit`. `message tasks` reads the ledger as last written, so settled history that a later send moves out may still count there. Request deadlines default to 600 seconds, configurable per message with `--timeout-seconds 1–7200`. Request waits use the same limits and `one`/`any`/`all` modes as worker waits, and each run has one active wait. Incoming conversation can interrupt a parked wait without settling its requests. `cancel-request` cancels an obligation; `cancel-wait` only stops waiting. Completion without a reply, failure, cancellation, destruction, timeout, or sender closure settle obligations distinctly. Late replies remain visible without reopening them.

Messages reach a live recipient as soon as they are accepted, including mid-turn: Claude, Codex, Pi, OMP, OpenCode and Antigravity steer them into the running turn, and the model reads them at its next step. Pending conversations go together, in order, up to 32 messages and 100,000 formatted characters per batch; a single valid message is never split. Every message keeps its ID, sender, delivery receipt and request outcome; receipts show queued, delivered and read (when the agent's harness can tell) separately. A pending human question holds messages until it is answered, then they follow right behind the answer. The thread's Details distinguish creation, delivery confirmation and event-recording times.

Sending a message to a review, terminal or held (usage-limit/provider-error) participant reports `not-delivered` and `continuation-required`, with the reason and next command; the CLI exits 1. An active supervisor can use `hsq worker resume` to continue its settled done/review/failed/cancelled or held worker with that message as the new instruction, and may pass `--model <model>` and `--effort <low|medium|high|xhigh|max|auto>` to switch model or effort on the worker's existing runner. `hsq worker inspect` and `hsq worker list` report a held worker's `hold` (`reason`, `resumeAt`, `attempts`, `error`), and a waiting supervisor receives a progress notice when a waited-on worker enters a hold. No human Continue is needed for this supervisor-controlled action. A retry with the same payload and ID never creates another continuation; resuming after a rejected message requires a new ID. Stopped or destroyed workers need a new worker. Workers cannot resume parents, and conversation never answers a pending human question. Durable IDs deduplicate accepted queue entries and event replay, but a crash between provider acceptance and its durable delivery checkpoint can leave transport delivery ambiguous; this is not an exactly-once execution guarantee.

Collect returns the worker's execution revision, status/outcome, `settled` and `partial` flags, and typed availability for assistant summary, HEAD, bounded diff and artifact descriptors. For a shared worker it also returns `changes` ([Shared workspace](#shared-workspace)). Missing evidence is explicit; running output is partial. An available `diff.path` points to a **JSON result file** containing `{ result, diffSnapshot }`; its `diffSnapshot` field holds the patch. Read and review that field before applying any changes. The latest collected result is stored under the parent and survives restart. Collection acknowledges observation, not Git integration or successful work. Review desired worker commits and deliberately integrate them into the parent before destroying their worktrees/branches; there is no automatic merge.

Parent completion requires collection of every worker's latest settled execution revision. A worker Continue invalidates older readiness. An early completion attempt waits for outstanding workers and wakes the parent to inspect/collect; it does not silently finish on wake. While workers remain live, markerless replies, completion timeouts, and repeated premature completion park the parent as monitoring with the existing capped wakeups. Once workers settle, repeated completion without collecting their results retains attention. Human Finish also refuses unresolved/uncollected workers. If the parent is already under review, Continue the parent first, then Continue its worker. Human questions remain authoritative.

Stop requests cancellation; `stopping` does not prove termination. Destroy checkpoints obtainable results, waits up to 30 seconds for proven termination, and removes only verified owned resources. An `incomplete` response lists remaining resources; resolve the cause and retry explicitly. Cleanup order is: collect/integrate desired results, destroy owned resources, explicitly delete child histories through the cockpit/API, then delete parent history. Parent-owned summaries and bounded diff snapshots remain until parent deletion, including after child-history deletion; general artifact bytes are not archived. Branch/path strings and SHAs become historical descriptors after removal, not promises of available Git objects or files. The human cleanup endpoint `POST /api/v1/p/<projectId>/runs/<worker-id>/worker-destroy` stays available when delegation is disabled. The CLI bounds each HTTP request to 45 seconds and rejects endpoint/auth/origin overrides and redirects.

Provisioned root tasks and workers may use native subagents, and each mechanism has its own purpose. Use native subagents for work that needs no separate worktree: research, code reading and focused analysis, for example a subagent that reads the parser and summarizes its error handling. Native subagents need no worker creation, worktree, collection or destruction. Use Squawk workers for work that needs its own worktree, its own commits or a tracked lifecycle. Workers may use native subagents too; a root's worker may also start one shared-workspace Squawk worker ([A worker that starts a worker](#a-worker-that-starts-a-worker)). An agent may message its own subagents with its runner's tools; it reaches another Squawk task only through `hsq message`. Where a runner's native tool for reaching another session is separate from subagent messaging, a per-run adapter control turns it off: Codex's cross-thread message board, and an OpenCode plugin that refuses a `task` call whose `task_id` names a session outside the caller's own session tree. Claude sessions refuse messages from other sessions on every launch. Known limitations: a Claude session Squawk starts can still list and message Claude sessions that Squawk did not start, and sessions on other machines; an OpenCode session that an older Squawk created under delegation keeps its `task` deny on Continue and restart recovery, because OpenCode cannot remove a session permission rule (new OpenCode sessions allow subagents). These controls are cooperative same-user supervision, not isolation ([Governed delegation controls](../AGENT_PROTOCOL.md#governed-delegation-controls-d1)). When the listener is unavailable, ordinary tools/settings stay unchanged. The listener binds to `127.0.0.1`, including hosted cockpit mode. Its session credentials authorize only what that session may do: a root manages its own workers and messages peer roots in the same project, subject to the task's settings and relationship checks; a worker addresses only its supervisor and a worker it started. This is cooperative local-agent supervision; same-user unrestricted shell and custom tools are not hard isolation. Workers cannot message peers through Squawk, and a worker that another worker started cannot spawn Squawk workers. Review remains a human gate with no automatic acceptance. Never read, echo, forward, or persist the generated token.
