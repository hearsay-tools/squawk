# CLI entry and subcommands

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/index.ts`, `packages/cezar/src/core/cli-registry.ts`, `packages/cezar/src/built-in-cli-commands.ts`

## Two project directories

Project entry points use `projectPaths`: the write root is the first read root, the
other directory is the fallback. The write root is `.ai/cezar/`, or `.ai/squawk/` for a
fresh or moved project (a completed migration's marker in the Git common directory,
hearsay-tools/cezarion#3150). `init`,
generated task paths, task state and config writes go to the write root; `init` skips a
starter workflow whose name already exists in the fallback.
Singleton config/context files use whole-file presence precedence. Reads never
create a fallback directory or an empty legacy run store that hides its data.
Git excludes cover both runtime trees and `.ai/squawk-migration.json`; tracked
workflows, skills and `context.yaml` keep their existing committable paths.
A project that still writes `.ai/cezar/` gets one legacy-directory notice. A blocked automatic move prints
one detailed notice; later readers omit the generic notice for that cause. Fresh means no
`.ai/cezar` path, including no empty directory. Such a project starts in `.ai/squawk/`
and preparation or its first CLI write records the same Git marker as a completed move.
`init` help names `.ai/squawk/`.

## Project migration fence

Every CLI operation that touches project data checks the migration fence
([project routes](project-routes.md#project-migration-fence)) and exits 1 with a
one-line `ProjectMigrationFencedError` message. `serve` checks in its ownership claim
before the listener and before any directory is created. `run` and `init` check in
`cli-dispatch.ts` (`admitProjectCommand`);
Every CLI write that follows an await re-checks admission right before it runs
(`admittedWrite`): `init` before its directories, each starter file and `.gitignore`; the
headless store open before `.gitignore` and the open (later store writes pass the store's
backstop, and the run's claims keep another process's fence from passing its preflight);
the artifact writer before each mkdir, write, rename and removal.
`artifact publish` checks the data directory of `CEZ_ARTIFACTS_DIR`; `versions` skips
the run lookup of a fenced project. `task`, `automation`, `webhook`, `worker`,
`message`, `discover` and `remote-settings` reach the project only through the
cockpit, whose project routes refuse. `backup`, the managed install commands and
`server-*` touch no project data. Git excludes also cover `.ai/squawk-migration.lock*`.

Before that check, `serve`, `run`, `init`,
`artifact publish` and `versions` finish an unfinished migration journal
([early recovery](project-routes.md#project-migration-command-and-early-recovery)); a
journal that cannot finish ends the command with its cause, exit 1. No CLI write targets a
path the migration moved: `artifact publish` refuses (exit 1, nothing written, never
recreating the old directory) when its `CEZ_ARTIFACTS_DIR` or its task's handoff file moved to
`.ai/squawk/` (`movedProjectPath`); the task gets its new paths when it continues.

## `migrate-project`

`migrate-project [--dry-run] [--repo <dir>]` (`project-migration/cli.ts`) is registered,
listed in help and dispatched. Only the user runs it, and it runs
offline: it refuses while a cockpit serves the project (the `cockpit.lock` owner, or a live
cockpit of the user's legacy or split home whose registry lists the project) or any task of it is live, and
names each pid, URL, port or task to stop. It cannot see a cockpit of another home that
lists the project but never opened it: stop such a cockpit yourself first (while the
fence holds, the write backstop refuses its store and listed state writes). It then takes `cockpit.lock` and the migration
fence, moves the state and releases both. A dry run first completes and reports an
unfinished migration, if one exists. It then holds `cockpit.lock`, passes admission and
plans; planning the remaining migration changes nothing. It prints the plan, then `Dry run:
nothing was moved or rewritten.` (or, after such a recovery, `Dry run: planning changed
nothing; the completed migration above did.`) or `Migration complete.`; it prints the `git mv` commands for
tracked files and never runs them. A dry run with plan blockers or conflicts keeps
that output on stdout and exits 1, including when the plan has no moves. Other refusals (in use, a held fence, conflicts, an untrusted
journal) print one message to stderr and exit 1. A cockpit moves each
registered project by itself at start, and a project added later when it is added, when
nothing else is live and its plan has no blocker or conflict; otherwise the project stays
in place and its single notice names the blocker or conflict, even with no planned moves
([automatic move](project-routes.md#project-migration-command-and-early-recovery)); CLI
entries (`run`, `init`, `artifact`, ...) only recover journals and never start a move.

## Rules

Uses `node:util` `parseArgs`, no CLI framework. `serve` is the default command. All 20 built-in commands register lazily in `core/cli-registry.ts` from `built-in-cli-commands.ts` with `parseMode`, `homeMode`, `runtimeMode`, usage lines, and a lazy `load()` ([ADR 0069](../adr/0069-adopt-register-then-seal-registries-for-extension-tables.md)). `index.ts` registers and seals only the CLI registry before dispatch; `cli-dispatch.ts` generates `--help` from it and `home/entry.ts` reads `homeMode` from it. Only commands whose `runtimeMode` is `'always'` or whose `runtimeMode(argv)` predicate returns true run `prepareCommandRuntime` (`subcommands.ts`) to register and seal runners, removal slots, worker executions, step kinds, agent tools, and wait kinds, keeping cold commands free of runner and store modules. Headless `run` treats `review` as a terminal success status (exit 0). `serve` boots in a fixed order: bind the listener, open the boot store and build its `RunManager`, `recover()` the boot project, then `startServer`. So anything a recovered run needs (its cockpit address, for one) must reach the boot manager at construction, not from `startServer`. `init` never overwrites existing files. Keep `.ai/cezar/.gitignore` maintenance (`ensureDataGitignore`) in sync with any new state file.

## Task environments and the cockpit home

`CEZ_HOME` and `HSQ_HOME` stay in the cockpit. No child receives either, including with
`HSQ_AGENT_ENV_FULL=1` (`CEZ_AGENT_ENV_FULL` fallback) or `HSQ_ENV_PASSTHROUGH=CEZ_HOME,HSQ_HOME` (`CEZ_ENV_PASSTHROUGH` fallback). Task commands
(`artifact`, `job`, `message`, `worker`, `task`, `automation`, `webhook`, `discover`)
do not read the cockpit home. Artifact links use the supplied `HSQ_PROJECT_ID` (`CEZ_PROJECT_ID` fallback);
without it they keep the unprefixed task link.

Operator commands (`projects`, nested `run`, `remote-settings`, `backup`,
`install`, `update`, `versions`, `use`, `link`, `unlink`) retain their home access.
Inside a task they now resolve the default home because the cockpit's
`HSQ_HOME` (`CEZ_HOME` fallback) override is absent. Their command behavior is otherwise unchanged.

## Long commands (`hsq job`)

`hsq job start <name> -- <command>` runs a command under a supervisor that leads its own session,
so it outlives the shell call, the turn and the agent session on every runner
(hearsay-tools/cezarion#3097). `jobs/job.ts` owns the supervisor, its claim of the name and the
`<name>.<run>.log`, `<name>.<run>.exit` and `<name>.job.db` files; they live in `$TMPDIR` unless
`--dir` names another directory. A task's `$TMPDIR` outlives the task while a job recorded in it
runs (`jobRunsIn`; the archive asks it through the jobs deletion gate, `jobs/removal-slot.ts`): the task-end reap, archive and the startup sweep spare it, and the next of them
that finds no job running removes it (hearsay-tools/squawk#3138). The end-time reap marks the end it
kept the directory for, so later run events of that end, such as a read mark, keep it too
(`jobHoldsScratch` in `workflows/run/run-settlement.ts`); once the run is archived, the mark holds
nothing. `hsq job stop <name>` ends
the job's whole process group, which the supervisor leads (hearsay-tools/squawk#3941). After the
supervisor has exited, it ends the members left in the group only where the record's start token
proves this boot (Linux, the worker scope's rule in ADR 0032); elsewhere it reports them and
signals nothing. Agents stop a job with it, never with
`kill <pid>`: that signal reaches only the command, and a child that ignores SIGTERM keeps running.
The launch prompt's
"Long commands" part (`jobs/command.ts`) gives agents the full command; the `cezar_wait`
description names it only as `hsq job start`, because the tool list also loads inside omp. A result is one JSON object on stdout and an error is one on stderr; `--help` prints text. The rules are in
[the unified waits spec](../../.ai/specs/2026-10-17-unified-waits.md#the-job-command-2026-11-10).

## Legacy home recovery

The host operator can use `hsq backup import <file>` or
`hsq backup ignore <file>` for a legacy-change row. Both use the same recovery
writer as the cockpit. Import applies legacy deltas after a required backup;
Ignore keeps the live file. Both record the current legacy hash and next merge
base. Deleted legacy files allow Ignore only. `hsq backup --help` lists these
actions.

Remote-settings grants remain host-CLI-only, even for a local cockpit. Their
legacy banner rows show these commands. Existing `backup list` and `backup
restore` behavior is unchanged.

Before migration, `hsq migrate --resolve-legacy <file> restore|accept` resolves
an outside-write or reset incident on the legacy home. It uses the pinned restore
or acceptance writer directly, without preparing or migrating the split home.
Help lists both actions.

Product task-context reads accept `HSQ_*` first with `CEZ_*` fallback during
the deprecation window. The `CEZ_HOME` fallback is permanent.
Generated child entries carry both names and the same value. Empty context values remain
intentional clears. `core/product-env.ts` owns both selection and generation.

Fresh project writes also require an absent or real `.ai/squawk` directory. A
symlink or file keeps legacy writes and is never marked fresh. The destination
check is shared with migration planning. If a cockpit is known but its live tasks
cannot be read, migration still refuses and lists both the cockpit and the read
failure. It does not treat the failed read as an empty task list.

## CLI metadata

Every binary name accepts `--version` and `-v`. Both print the package version to
stdout and exit 0 without resolving or preparing a home. Old names still print
their notice only to stderr. Top-level help shows the resolved home's versions
directory; reading this path does not prepare or migrate the home. If resolution
fails, help describes the data folder without a path and still exits successfully.
Discovery's missing-cockpit hint uses the preferred command.

## Dependency wait bounds

`cezar_wait`, `hsq worker wait` and `hsq message wait` accept worker, request
and peer deadlines of 1–7,200 seconds, default 600. Ordinary `hsq message request`
deadlines use the same range; a settled worker resume request can reach 86,400
seconds. Timeout refusals name the accepted range. A wait does not extend a
request deadline or cancel its dependency when it expires.

An empty dependency deadline (worker, request, peer or process) wakes the task
without spending automatic-wake budget. Peer messages and substantive peer and
process outcomes retain their charging rules. Explicit timer and native-subagent
safety deadlines remain charged. See [ADR 0061](../adr/0061-one-wait-engine-executes-wait-kind-rows.md#longer-dependency-waits-and-empty-deadline-wakes)
for mixed batches, spent budgets and restart behavior.

## From the terminal: `hsq task` and `hsq message`

`hsq task` starts, watches and steers tasks **in the running cockpit** from a shell — for you, or
for a bot driving one. Every command prints one JSON object and exits with a code the caller can
branch on, so nothing has to parse prose. It never starts a server: it finds the cockpit whose
project registry holds this checkout (ports 4321–4370; a task worktree resolves to its parent
project), or you point it at one with `--url` / `HSQ_URL` (`CEZ_URL` fallback).

```text
hsq task [--url <origin> | --repo <dir>] <operation> …
```

The shared `--url`, `--repo` and `--help`/`-h` flags also work before the operation;
`--url` and `--repo` accept both `--flag value` and `--flag=value`. A shared flag repeated
before the operation or on both sides is a usage error. Operation flags stay after the
operation. `hsq task --help <operation>` shows that operation's help without discovery.
An explicit `--url` wins over `HSQ_URL` (`CEZ_URL` fallback); `--repo` selects the checkout to discover.

`hsq task send` is human input. It can answer a pending human question. It refuses
inside a task (`HSQ_TASK_ID` (`CEZ_TASK_ID` fallback) is set). Agents use `hsq message` for task messages,
including peer and parent/worker conversations; see [Owned workers](../workers.md#owned-workers).

```bash
id=$(hsq task start --task-file - <<'EOF' | jq -r .id
Fix the `hsq task` docs. Keep $(example) and "quotes" literal.
EOF
)
hsq task wait "$id" --timeout-seconds 900                     # 0 done/review/needs you · 1 failed · 3 timeout
hsq task list                                                # currentStepId (running), pullRequestUrl (done/review), capped error (failed)
hsq task status "$id"                                       # slim JSON: status, attention, question, branch, handoffUrl…
hsq task send "$id" 'Use the retry helper instead'            # delivered live, queued before start
hsq task send "$id" --resume 'Continue with the next step'    # resumed: reopen a settled session
hsq task log "$id" --follow --timeout-seconds 300             # JSON lines until it needs you or ends
```

`list --status` accepts comma-separated values: `queued`, `running`, `waiting`, `review`,
`done`, `failed`, `cancelled`. Default rows include only the next-action field for their status
when defined; errors use the first line, at most 200 characters including `…` when cut.
Default `status` includes `handoffUrl`, a URL to the existing handoff endpoint even before
contents are seeded, and keeps the full error. `--full` still prints the contract unchanged.
To answer a pending `question`, use the same `send` with the answer text. Without `--resume`,
a closed session returns `delivery: not-delivered` and the `next` command. For multi-line or
shell-sensitive messages use `send <id> --text-file <path|->` (`-` reads stdin); the quoting
rules below apply to messages too.

Use `--task-file PATH` to read a saved task (for example, `hsq task start --task-file task.md`),
or `--task-file -` to read stdin as above. The quoted heredoc delimiter (`<<'EOF'`) keeps
backticks and `$()` literal in the task text.

POSIX shells, including Bash, expand backticks and `$()` in double-quoted arguments before
hsq receives the text. **Do not put raw backticks in double-quoted task arguments.** This can
execute parts of your prompt as shell commands and leave holes in the stored task, including
when starting tasks through SSH and `bash -lc`. Prefer a task file or stdin with a quoted
heredoc delimiter. A single-quoted positional argument still works for short tasks:
`hsq task start 'Fix the typo'`.

`hsq task start --task-file task.md --skill <name>` names one skill as the task's agent step;
`--skill` and `--workflow` are mutually exclusive. The CLI checks
`GET /runner-skills?runner=<id>` for the selected runner and project account first and
includes a `warning` in its JSON result if the skill is missing or the catalog cannot be
checked; it still starts the run. Step open resolves the id against the runner's list
in the execution folder. A missing or ambiguous selection fails before a model call.
CLI starts do not change
the cockpit composer's recent picks or skill-usage ranking.
Without either flag, `start` still runs `quick-task`.

`--runner <claude|codex|opencode|pi|omp|antigravity>` picks the runner, as in a workflow step and
`hsq discover --runner`; `--model` and `--effort` pin the rest. `--backend` is a permanent
alias of `--runner` with no warning. Giving both with different values exits 64.

`--archive-when-done` archives the task after **Done**. `--auto-merge-pr` merges its
PR after **Done** only when current-head CI and GitHub rules pass. It can mark a
draft PR ready. Both controls are off by default. They also appear as switches in
the task composer and task details. With both on, Squawk merges before it archives;
without a PR, it archives on Done. Pending or blocked completion actions show their
reason in task details. Use `status <id> --full` to read the saved `archiveWhenDone`,
`autoMergePr` and `completionAction` fields. Existing task choices can be changed
through `PATCH /api/v1/p/:projectId/runs/:id` with the matching boolean fields.

`start` is retry-safe: it sends a request id (`--request-id <UUID>` to pick your own), and a
retry with the same id and start options answers with the run the first one created
(`created: false`) instead of starting a second. Changing a completion control on that
retry is a payload conflict. Also: `list`, `stop`, `finish`, `diff [--stat]`, `open`.
Use `archive <id>` to hide a task from `list`, `unarchive <id>` to restore it, and
`list --all` to include archived tasks. `list` never shows owned workers, with or without
`--all`: they are steer targets of their parent task. Id-addressed commands (`status`, `wait`,
`send`, `log`, `stop`, …) still accept a worker's id. `archive-finished` sweeps finished tasks (not scheduled runs waiting on a usage limit, and not owned workers, which leave with their parent) and prints
`{"archived": count, "ids": [...], "pinnedIds": [...]}`. The single-task commands print `{"id": "…", "archived": true|false}`.
Exit codes:
`0` ok (`wait`/`start --wait`/`log --follow`: the task ended `done`/`review` or stopped for attention), `1` task
failed/cancelled or a message was not delivered, `2` no cockpit or the cockpit refused (its `error`
is passed through), `3` timed out, `64` usage error. `hsq task --help` lists every flag.

**When a task needs you.** `status`, `list`, `wait` and the final `log --follow` line carry `attention` and `attentionLabel`,
derived by the same function the cockpit's Needs You uses, so the CLI and the cockpit cannot
disagree. Read those rather than the raw status:

- `attention: waiting` (`attentionLabel` "needs you" / "needs review"), `error` or `permission`
  means the task wants a human. A `waiting` task is attention **even when no question is
  pending** — a finished turn parks the task for follow-up without a structured question —
  unless its top open wait is CI or a timer (below). A pending question shows as `question`
  on `status`, with the agent's Markdown context as `questionContext` when it sent one, and as
  `waitingOn` `{ kind: 'human' }`; never clear a task on its absence alone.
- `attention: running` with `attentionLabel` "waiting for CI", "waiting for merge" or "monitoring"
  (`status: waiting` with an open PR wait or timer in `waitingOn`) is neither settled nor attention: the agent is
  still working on its own sub-agents or a watched command, whatever its last log line says.
- `attention: none` with "waiting on 2 workers" is a task parked on its own workers; it will wake
  by itself.

`wait`, `start --wait` and `log --follow` stop as soon as a task needs you or ends
(`--until attention`, the default); `--until settled` waits for a terminal status only — for
`--autonomous` runs, or a bot that wants an outcome:

```bash
hsq task wait "$id"                                        # stops when the task needs you, or ends
hsq task wait "$id" --until settled                        # done/review/failed/cancelled only
hsq task start --task-file task.md --wait                  # returns as soon as the agent parks
hsq task start --task-file task.md --wait --autonomous --until settled   # runs to completion
hsq task log "$id" --follow                                # streams until the task needs you, or ends
hsq task log "$id" --follow --until settled                # streams until done/review/failed/cancelled
```

*Migrating from `--until settled`.* Before 0.16, `wait` and `start --wait` defaulted to
`settled`, so an ordinary interactive task ran out the timeout (exit 3) although the agent had
parked within seconds. The default is now `attention`. A bot that polls for terminal state adds
`--until settled` to its `wait` / `start --wait` calls; nothing else about `settled` changed. Each
run in the `wait` output (and the `start --wait` object) now carries `attention` +
`attentionLabel`, and the output's top level says which `until` was in force, so a caller can tell
"parked for follow-up" (`status: waiting`, `attention: waiting`) from "finished" (`status: done`,
`attention: none`) without knowing Squawk's status vocabulary.

*`log --follow` (#931).* `log --follow` used to stop on a terminal status only, so tailing an
interactive task streamed until `--timeout-seconds` and exited 3 after the agent had parked. It
now takes the same `--until` with the same `attention` default, judged by the same function as
`wait`; `--until` without `--follow` is a usage error. Every event is still printed before the
final line, which is now `{"id", "status", "attention", "attentionLabel", "until", "timedOut"}`. A
bot that tails to terminal state adds `--until settled`. `log` without `--follow` is unchanged.

**A bot that lives behind an HTTP endpoint** does not have to poll. Add a webhook (a name, a
description, a URL and an optional Bearer token) under **Webhooks** in the project's **Settings →
General** and turn on **Task notifications**. Every task that opts in then POSTs one delivery to
each such webhook when it enters a state that webhook selects: **Needs you**, **Failed**,
**Done** and **Cancelled** by default, plus **Running**, **Waiting for agents**, **Waiting on CI**,
**Waiting** (a timer) and **Any other wait** when you tick them. A question that puts the task in
Needs you is `task.question`; every other entry is `task.status`, and the body's `state` names the
state. `task.subscribed` (when it opts in, at start or on hand-off) and **Send test** always go out.
Each body carries the same slim projection `hsq task status` prints, under `task`. `hsq task start`
opts in only with `--notify` (off by default); the cockpit's New task form
has a **Notify webhook** toggle; and a running task's **Hand off** button (or
`hsq task notify <id> --message '…'`) turns it on later with a note for the bot. `notify` (and
`send --notify`) on a worker's id is a usage error that names the parent to notify instead;
`notify --off` still works on one. The note goes to
the webhook only, never to the agent. Delivery is best-effort: 10 s timeout, 3 attempts, and a
failure shows in the thread without touching the task. The token is stored in `<config>` and never
sent back to a browser. Under `HSQ_DRY_RUN=1` (`CEZ_DRY_RUN` fallback) nothing is sent; the payload is logged in the thread.

A project can hold several webhooks, each with its own states, and each body names the webhook it
went to under `webhook`. One failing webhook never delays or stops another.

### Reports from agents: `hsq webhook`

Turn on **Let agents send reports** for a webhook, and agents in that project can send it a report
on demand: a friction report to a triage bot instead of a new GitHub issue, for example. Agents see
each such webhook's name and description in their system prompt, so write the description as
instructions ("Send friction you hit with tools here instead of filing a GitHub issue"). A webhook
without that switch cannot be reached this way.

```sh
hsq webhook list                                         # the webhooks open to agents
hsq webhook send 'Friction reports' --message-file report.md --title 'Squeal skipped an edit'
hsq webhook send <name|id> --message 'Short report' [--data '{"severity":"low"}']
```

The body is `event: "agent.report"` with `webhook`, `title`, the Markdown `message`, your `data`,
and the reporting task's `runId`, thread `url` and `task` projection. The command prints the
outcome as JSON and exits 0 delivered, 1 not delivered, 2 refused or no cockpit, 64 usage.

### Automations from a task: `hsq automation`

`hsq automation` creates and manages automations (on by default; `HSQ_AUTOMATIONS=0` (`CEZ_AUTOMATIONS` fallback) disables them) on the cockpit that
runs the task, so an agent asked to "do X every morning" or "whenever a PR opens" sets up an
automation instead of a cron job. Like `hsq task`, it prints one JSON object per invocation and
exits 0 ok, 1 check failed, 2 refused or no cockpit, 3 check timed out, 64 usage.

```sh
hsq automation schema                                    # the definition reference (needs no cockpit)
hsq automation add --name 'Weekday triage' --cron '0 7 * * 1-5' --prompt 'Triage new issues'
hsq automation add --name 'Review PRs' --on pull_request.opened --every 5m --label bug --prompt-file p.md
hsq automation add --name 'Agent triage' --on issue.labeled --changed-label needs-agent --prompt 'Triage #{{github.number}}'
hsq automation create --file def.json [--enable]         # full JSON form; stdin when no flag is given
hsq automation update <id> --json '{"task":{"prompt":"…"}}'
hsq automation add --name 'Check the rollout' --at 2026-10-29T09:00 --tz Europe/Warsaw --prompt 'Check the rollout'
hsq automation add --name 'Follow up' --in 7d --latest-start 6h --prompt 'Follow up on the migration'
hsq automation check <id> [--execute] · run <id> · list [--archived include|only] · show <id> · enable <id> · pause <id> · cancel <id> · delete <id>
```

`add` and `create` send the same body and create the automation **paused** unless `--enable` is
given; `--cron` accepts the four shapes a schedule can take (daily, weekdays, one weekday, every N
hours) and anything else is a usage error pointing to the JSON form. `update` replaces each key
it is given, except `task`, which merges key by key (`null` removes one); it restates `enabled`
and echoes the revision it read, so a concurrent edit in the cockpit is refused (exit 2), never
overwritten. Mutating commands print the automation's cockpit page as `url`.

`add` accepts `--archive-when-done` and `--auto-merge-pr` with the same behavior as
`hsq task start`. The JSON keys are `task.archiveWhenDone` and `task.autoMergePr`.
Both are optional booleans and default to off. The automation editor has the same
switches. Editing these choices affects future tasks only; it does not change tasks
the automation already launched. Enabling an automation or making its tasks autonomous
does not enable either completion control.

GitHub automations exclude events before enablement by default. Turn on **Include existing items**
in the editor, pass `--include-existing` to `add`, or set `"filters": {"includeExisting": true,
"lookbackDays": 7, "maxRecords": 25}` in a JSON definition to include older matches within the
lookback (1–90 days). Turning this on for an enabled automation reopens that window on its next
check. Changing only the lookback preserves the completed cursor; pause and re-enable to
reopen the wider history window. Previously processed matches stay deduplicated across edits, pauses and restarts, and
per-check limits still apply. Historical scans resume across checks and restarts when capped.
GitHub search is limited to 1,000 items per window and label timelines to 100 events per item;
reaching either limit reports an error with guidance to narrow the filters or lookback. **Test filter** previews the selected window independently of the
execution cursor; it never launches tasks. For label triggers, the window applies to the label
event's time, so a newly added label can match an old issue even with history off. Historical
label discovery revisits the rolling window because later comments can move issues between pages;
receipts prevent those repeated observations from launching duplicate tasks.

A **one-time schedule** (**Once** in the editor, `--at` or `--in` on `add`, `"schedule":
{"type": "once", "at": "2026-10-29T09:00", "timeZone": "Europe/Warsaw"}` in JSON) starts one
ordinary task at a wall-clock time in an explicit IANA zone. It is created paused like every
automation; **Enable** arms it. When it is due, Squawk starts the task and moves the schedule to
**Archived** with a link to that task; **Run now** does the same at once, so it never runs twice.
**Cancel** archives it without a task. An archived schedule cannot change, and the list hides it
until you pick the **Archived** filter. Squawk must be running at the due time. If it was not,
the schedule starts on the next boot only within its **Latest start** (no limit by default; 10
minutes to 30 days); after that it is marked **Missed** and stays until you edit, cancel or run it.
A launch that fails marks it **Failed**, and nothing retries on its own; **Retry** or **Run now**
relaunches the same receipt, so one schedule starts at most one task. Agents can create and manage
one-time schedules with the `cezar_schedule_task` and `cezar_scheduled_tasks` tools, which exist
by default unless `HSQ_AUTOMATIONS=0` (`CEZ_AUTOMATIONS` fallback) and also create schedules paused unless the user asked for them to run.
These tools take and answer the due time in UTC, like every other time in a Squawk tool; the
schedule keeps a wall time in the cockpit's time zone, so the cockpit shows it in local time.

Automation list counters use two windows. **Launched** counts every stored task with that
automation's provenance, across definition revisions, including historical variants, completed and
archived tasks. Restarting or compacting automation logs and receipts does not change it;
deleting a task removes it from the count. **Matches**, **Duplicates** and **Errors** describe
only that automation's latest 100 activity-log rows. Recent activity remains a separate log view.

The address comes from `HSQ_COCKPIT_URL` (`CEZ_COCKPIT_URL` fallback) and `HSQ_PROJECT_ID` (`CEZ_PROJECT_ID` fallback), which the cockpit puts in a task's
environment. Without them, only an explicit `--url`, `--repo` or `HSQ_URL` (`CEZ_URL` fallback) looks for a cockpit;
otherwise the command exits 2 and never starts a server. With automations off, the cockpit's `409`
is relayed verbatim (exit 2).
