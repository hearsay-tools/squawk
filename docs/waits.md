# Waiting for PR checks, merges and timers

An agent waits on something outside its turn with `cezar_wait`. With `kind: "pr"` and
a GitHub PR URL in `pr`, Squawk watches the PR outside the model: its checks
(`until: "checks"`, the default), its eventual merge (`until: "merge"`), or a merge
the agent has requested (`until: "merge_or_blocked"`). The last target wakes when
the PR merges, closes, conflicts, or is neither queued nor scheduled for auto-merge.
It includes any known queue-removal or auto-merge-disable reason. A pending queue
slot or enabled auto-merge keeps it open. The ordinary merge target ignores queue
removal; use `wake_on_conflict: false` for a dependency wait that also ignores
conflicts. Only `merged` confirms success. The optional
`timeout_seconds` defaults to 1,800 and accepts 1–7,200. With `kind: "timer"`,
`seconds` (60–7,200) and an optional `note`, Squawk wakes the agent at that time and
hands the note back. No authored configuration or worker delegation permission is
needed. A PR wait requires `gh`, access to the repository, and a supported GitHub
host; GitHub Enterprise hosts must already be recognized by the forge/auth
configuration. Tool startup itself makes no GitHub request. With **Monitoring
wake-up** turned off in **Settings → Resources**, `cezar_wait` refuses a timer
(`timers_disabled`); once the automatic-wake budget of 40 is spent, it refuses one
with `wake_budget_spent`, and a run with nothing else to wait on waits for you. The
budget is kept on the task, so a cockpit restart keeps it; a message from you or a
Continue starts it again.

A CI wait stays pending while any GitHub Actions workflow run on its captured
head commit is incomplete, even when a rerun temporarily hides that run's checks.
It checks again every 30 seconds within the original deadline. Once those runs
complete, it reads the checks again to decide the result. A result describes what
GitHub reported; it does not predict workflows that have not appeared yet or grant
merge approval.

A merge wait (`until: "merge"`, hearsay-tools/cezarion#1425) reads the PR's state at
once and then every 30 seconds within its deadline. It ends as `merged` only when
GitHub reports the PR merged, with the merge time and merge commit when GitHub gives
them, and as `closed` when the PR closed without merge. Green checks keep it open,
and so does a new head commit. A merge wait holds none of the four watcher slots, so
long merge waits never delay a checks wait. By default both targets also end as
`conflicting` when the PR has merge conflicts. Set `wake_on_conflict: false` when the
agent watches a PR it does not own, such as another agent's PR its work depends on:
it cannot resolve those conflicts. With `until: "checks"`, GitHub often runs no
workflows on a conflicting PR, so such a wait usually ends as `no_checks` or at its
deadline. A checks wait and a merge wait on the same PR are two waits.

The agent asks you with `cezar_ask`, a card of one to four questions in the ask
format. A question with two to four options shows them as choices; a question without
options is open, and the card shows a text box for your answer. The task reads Needs
you once the turn ends, and your next message answers it. `cezar_wait` takes PR, worker, request,
peer, process and timer waits only, and points an agent that asks it for a human wait to `cezar_ask`. A run
has one question to you at a time, and the agent cannot cancel it once you have seen
it. A native question opens the same kind of wait. When the work is
done and verified, the agent calls `cezar_done` (an optional `summary`), and the task
finishes at the end of that turn: its open waits are cancelled and the summary is
written as a note. In a workflow step that is not the last, `cezar_done` finishes that step
and Squawk starts the next one. `cezar_done` refuses while owned workers are live or uncollected,
a worker question is unanswered or a question to you is still pending, and says what to do first. An
autonomous task does not wait for you until its automatic-wake budget is spent. When the
agent's harness neither acknowledges nor answers an autonomous nudge within 5 minutes, Squawk
writes a note that names the nudge and closes the session. The task then waits for a Continue,
with no question to you.

A run can have several waits open at once, up to 16. Each answer carries the
wait's id, its absolute deadline and the list of waits still open, and
`cezar_cancel_wait` closes one by its id. The agent ends its turn to wait, with no
marker required. The run is then `waiting`, and the pill reads **waiting for CI**,
**waiting for merge** or **monitoring** rather than Needs you. The header lists every open wait: **Waiting
for CI — owner/repo#N** or **Waiting for merge — owner/repo#N** with a PR link and the deadline, or **Next automatic check**
with its time and note. **CI result ready — waiting for capacity** means the
observation is owed to the agent and its wake turn has not started yet. A run parked
on CI or a timer keeps its agent slot, a monitoring slot when one is free, so the
wake usually starts at once. Claude's `ScheduleWakeup` opens a timer in the same list.

Every agent session needs these tools. Squawk starts a private local socket for them,
in the system temporary directory, when the first session of a cockpit launches. If it
cannot start, for example because that directory is full or not writable, the task fails
before the agent starts. The error names the cause and the fix: free space or fix the
permissions, then Continue the task. A task woken by a wait retries with the usual backoff.
The cockpit and other tasks keep working, and the next launch tries again.

Squawk reports passed, failed, cancelled or skipped checks, no checks, changed head,
timeout or an operational error. It watches the registered commit: a new PR head
is reported separately, and the agent decides whether to wait again. The first
observation runs immediately. Later check-status and PR-head polls run every 30
seconds, and no setting changes that interval. Four watchers run concurrently;
queued waits retain their original deadline. Results are bounded
observations, not merge approval or evidence that every expected workflow appeared.
The agent still decides its next action; CI success never completes the task or
accepts review. A wait ends only when its own result arrives, its deadline passes,
or someone cancels it: the agent with `cezar_cancel_wait`, or Squawk when the task
is stopped, finished, cancelled or deleted. A human message wakes the agent without
closing any wait, and every delivered turn ends with a list of the waits still open.
CI never answers a pending human question. If the agent's session fails or closes while a
result is owed, Squawk retries the delivery after 15 and then 30 seconds; a third
failure marks the task failed and keeps the result. Continue delivers it, and Stop
discards it and leaves the task failed.
Controller recovery can replay an
observation after an ambiguous delivery checkpoint, identified by its stable
lifecycle input ID.

The deprecated `cezar_wait_for_ci` tool was removed (hearsay-tools/cezarion#1236):
call `cezar_wait` with `kind: "pr"` instead. `kind: "ci"` itself was replaced by
`kind: "pr"` (hearsay-tools/cezarion#1425) and is refused with a message that names
the new spelling.

The adapters are bundled for Claude (including `claude-cli`), Codex, OpenCode,
Cursor, Pi and OMP. Internal socket/capability environment values are runtime wiring,
not settings to create or share. If the tool is unavailable or denied, its error
is surfaced while ordinary tasks continue. See [the CI-wait protocol](../AGENT_PROTOCOL.md#ci-wait-tool-contract-474)
for the owners of the limits and the harness evidence required before a runner ships.
