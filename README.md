<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/web/public/cezarion-mark-dark.svg">
  <img src="packages/web/public/cezarion-mark-light.svg" alt="" width="96" height="96">
</picture>

# Squawk

**Parallel coding agents orchestrator** — a local cockpit for running and
tracking AI coding-agent tasks in your repo.

Type a task, pick a workflow and an agent — **Claude Code, Codex, OpenCode, Cursor, pi or
OMP (OpenCode, pi and OMP experimental), or a mix of them per step** — and watch it work live: steps, tool calls,
tokens, diffs, in a browser cockpit that runs entirely on your machine.
Your CLI logins, your `gh`, your files. No accounts, no database server, no cloud.

🔥 **Fire and forget.** Queue a stack of autonomous coding and maintenance
tasks and let them run — Squawk orchestrates them across isolated worktrees,
in parallel. Flip the **Autonomous** flag
and a run never stops to ask; it just finishes. Leave it on a VPS and you get
a dev team that's *always on* — a mobile-friendly cockpit you can check from
your phone, working your backlog while you're away.

[A look inside](#a-look-inside) · [What Squawk does best](#what-squawk-does-best-) · [What it solves](#what-it-solves) · [Who it's for](#who-its-for) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Core concepts](#core-concepts) · [Cockpit tour](#cockpit-tour) · [Agent backends](#coding-agent-backends) · [Remote access](#remote-access-host-squawk-on-a-server)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node 24.21.0+](https://img.shields.io/badge/Node-24.21.0%2B-339933)
![TypeScript 7.x](https://img.shields.io/badge/TypeScript-7.x-3178c6)
![Zero config](https://img.shields.io/badge/config-zero-success)
![Embedded SQLite](https://img.shields.io/badge/database-embedded%20SQLite-success)

</div>

---

```bash
cd your-repo
npx -p @hearsay-tools/squawk hsq   # → cockpit at http://localhost:4321
```

That's the whole setup. If your `claude` CLI is logged in (Pro/Max) and `gh` is
authenticated, there is nothing else to configure. State lives in `.ai/squawk/`
inside your repo (`.ai/cezar/` in a project that has not moved yet): your runs in one embedded SQLite file (`runs.db`, built into
Node: no server, no install, no config), event logs in NDJSON and journals in
Markdown. Everything except the run file you can `cat` and fix by hand.

The cockpit checks npm for a newer release when it starts. When one exists, it prints
the command that starts the newest release and marks the version in the sidebar footer.
It does not install updates. Install the newer release the way you installed this one,
then restart the cockpit.

Upgrading from Cezarion? Read the [migration guide](docs/migration.md) before
moving a desktop, server or custom-home install. User paths such as `<config>`
and `<state>` below refer to its [platform roots](docs/migration.md#home-directories).
A cockpit moves each idle project's state from `.ai/cezar/` to `.ai/squawk/` at start
([project folders](docs/migration.md#project-folders)). Release operators use the [publishing runbook](docs/publishing.md).

## A look inside

Click any thumbnail for the full-size screenshot.

| Orchestrate parallel agents | Watch a run live |
|:--:|:--:|
| [![The Tasks view with running and queued tasks](docs/screenshots/task-view.png)](docs/screenshots/task-view.png) | [![A running task streaming agent text, tool calls and test output](docs/screenshots/live-run.png)](docs/screenshots/live-run.png) |
| *Run and queue tasks in isolated worktrees, with live status and resource use.* | *Every step, tool call, token and screenshot streams as it happens.* |
| **Workflow builder** | **GitHub, one click away** |
| [![The workflow builder](docs/screenshots/workflow-builder.png)](docs/screenshots/workflow-builder.png) | [![The GitHub tab](docs/screenshots/github-issues.png)](docs/screenshots/github-issues.png) |
| *Stitch skills and shell checks into a reusable YAML chain.* | *Hand an issue to an agent through your own `gh` login.* |

---


## What Squawk does best 🏆

**On your phone:** open your HTTPS cockpit in the phone's browser and add it to
the home screen. [Squawk on your phone](docs/mobile.md) shows how; agents continue
running on your server.

Plenty of tools wrap a single coding agent in a nicer window — a "Codex GUI", a
conductor-style app, one-agent front-ends. Squawk's bet is different. Three things
it does better than any of them:

- 🪶 **Genuinely zero config.** `npx -p @hearsay-tools/squawk hsq` in your repo and you're running —
  no wizard, no API keys, no env vars, no schema, no database server. It rides the
  `claude` / `codex` / `opencode` / `agent` (Cursor) / `pi` / `omp` logins and the `gh` you already have, and every
  missing piece degrades gracefully instead of blocking you.
- 🖥️ **Built for a server (VPS mode).** Squawk is made to live on a **VPS, cloud,
  or dedicated box** as an always-on janitor for your repo — headless-first, with
  a mobile-friendly cockpit you drive from anywhere. It's a coding server you can
  actually watch, not a desktop app bolted onto one machine.
- 🔀 **Parallel + autonomous orchestration.** The real edge: Squawk runs **many
  agents at once** in isolated worktrees, **queues** the overflow, and pushes each
  one **autonomously** through skill playbooks — fire-and-forget. This is exactly
  what single-agent GUIs don't do well: they babysit one agent, while Squawk
  orchestrates a whole team and drains your backlog while you're away.

---

## What it solves

Most "AI coding agent" tooling makes you choose between a **terminal** you can't
see into once it's running, and a **cloud product** that wants your API key, your
code on their servers, and an account. Squawk is the third option: the agents run
locally under *your* subscription, a cockpit shows you exactly what they're doing,
and an orchestrator keeps a whole queue of them moving.

- 👀 **No visibility into a running agent.** A headless `claude` run is a black box
  until it finishes. Squawk streams every step — agent text, each tool call and
  its result, tokens and cost per step — live, and keeps the full replay.
- 🧩 **One agent, one working tree, one thing at a time.** Kick off a second task and
  it fights the first over your files. Squawk runs each task in its **own git
  worktree**, so two (or three) agents work in parallel without stepping on
  each other — or on the branch you're editing.
- 🗂️ **A backlog that needs babysitting.** Queue a stack of tasks and Squawk
  **orchestrates** them: it runs up to your parallel limit and holds the rest in
  an ordered queue. Point it at a GitHub issue and it runs straight on that, so
  working the tracker down stops being a manual chore. Create ordinary tasks for
  the work you choose to run next.
- 🤖 **"Autonomous" means you still have to sit there.** Flip the **Autonomous**
  flag and a run never parks to ask — it keeps going until the task is done. Pair
  it with a **skill** (a Markdown playbook) and you've got fire-and-forget
  automation: hand off "fix this", "upgrade that", "triage these" and walk away.
- ✅ **The agent finishes and you have to trust it.** Every task's diff stays on
  its own branch: inspect it, send notes back into the same session, or push a
  **draft PR**. Auto merge is off by default; each task can opt in to merge after Done.
  Turn on the optional **review gate**
  (`HSQ_REVIEW_GATE=1` (`CEZ_REVIEW_GATE` fallback) or Settings → Agents) and a finished run with changes
  waits in `review` for you.
- ♻️ **Losing a session when it fails.** Every run records its `claude` session id.
  Take it over interactively in one click (`claude --resume <id>`), or continue it
  in-process from the cockpit. After a failure, Continue tells the agent which
  step failed and gives its saved error before your message. Restart recovery
  also explains the restart when replaying a saved message. Background commands
  may have stopped; the agent is told to verify their state before restarting them.
- 🔀 **Locked into one agent vendor.** Most tools wed you to a single CLI. Squawk
  drives **Claude Code, Codex, OpenCode, Cursor, pi and OMP** (OpenCode, pi and OMP
  experimental) through one runner seam — set a
  default, pick a backend per task, or mix them inside one workflow (implement
  with one agent, review with another) — and through **OpenCode**, **pi** or
  **OMP** you can point a run at **open-source or local models**, not just the
  big vendors. See
  [Agent backends](#coding-agent-backends).
- 🖥️ **Close the laptop and the work stops.** A local agent only runs while your
  machine is on and awake. Put Squawk on a **VPS, cloud box, or dedicated server**
  and the cockpit becomes the GUI for an **always-on AI coding team** — kick off,
  watch and steer tasks from your laptop or **phone**, on the train or between
  meetings, while the agents keep grinding through the backlog back on the server.
- ⚡ **Setup tax.** No wizard, no env vars, no schema. Skills are Markdown, workflows
  are short YAML, and everything degrades: no `gh` → works without PRs, no network
  → local skills still load, no `.ai/skills` → the bare prompt still runs.

---

## Who it's for

- **Solo devs and small teams** who want the leverage of coding agents without
  handing their code and keys to a SaaS — the agent runs on your subscription,
  on your machine.
- **`claude` CLI power users** who love headless runs but want to *see* them,
  and review a diff before it lands.
- **Anyone with a backlog** who'd rather queue three tasks into isolated worktrees
  and pick the winners than babysit one terminal.
- **Teams with shared conventions** who want their playbooks (skills) pulled from
  a git repo, applied consistently, with zero per-project setup.

---

## Quick start

**Prerequisites:** Node 24.21.0+, at least one logged-in agent CLI — the
[`claude` CLI](https://github.com/anthropics/claude-code) (Pro/Max subscription),
the [`codex` CLI](https://github.com/openai/codex),
[OpenCode](https://opencode.ai), the
[Cursor CLI](https://cursor.com/docs/cli/installation) (`agent`),
[pi](https://github.com/badlogic/pi-mono), or
[OMP](https://github.com/can1357/oh-my-pi) — and, optionally, `git` and the
`gh` CLI.

```bash
cd your-repo
npx -p @hearsay-tools/squawk hsq   # start the cockpit for the current repo
#   or install once: npm i -g @hearsay-tools/squawk, then run hsq

```

The cockpit opens at `http://localhost:4321`. If the requested port is occupied,
startup exits with an actionable error before recovering tasks. Automatic port
bounce has been removed (hearsay-tools/cezarion#722): open the existing cockpit,
stop the process using that port, or choose `hsq --port <free-port>` deliberately.
Use `hsq --port 0` to ask the OS for an ephemeral port. If another cockpit already
serves this repository, the command prints its URL and exits with an error,
even with a different port. Different repositories can run side by side on
explicitly different ports; after a cockpit exits or crashes, its repository
can start again without cleanup.
Type a task, pick a workflow, hit **Start**. That's it.

```bash
npx -p @hearsay-tools/squawk hsq run "add a --json flag to the export command"   # headless, CI-friendly
npx -p @hearsay-tools/squawk hsq init   # scaffold .ai/squawk/
```

For a global install, run `npm i -g @hearsay-tools/squawk`, then use `hsq`.
The old `cez` and `cezarion` commands still work during the
[deprecation window](docs/migration.md#rollback-and-the-deprecation-window), with one stderr notice per process. No API key is ever used — Squawk shells out to whichever agent
CLIs you are already logged into, `claude` by default.

> **Contributing?** [Local development](#local-development) shows how to get a
> global `hsq` command straight off your checkout (`npm run install-as-command`)
> — no publish needed.

> **Just kicking the tires?** Set `HSQ_DRY_RUN=1` (`CEZ_DRY_RUN` fallback) to run against a bundled mock
> instead of the real CLI — the whole cockpit works with no `claude` login, so
> you can explore runs and diffs offline.

### Nightly builds — help us shape Squawk 🌙

Every night we publish the trunk to npm, so the features landing in the next
release are one command away:

```bash
npx -p @hearsay-tools/squawk@nightly hsq   # everything merged as of last night
```

**Come build this with us.** Squawk is shaped by the people who run it on real
repos: if you try a nightly and something feels wrong — a workflow that stalls, a
diff that reads badly, a runner that should exist — [open an
issue](https://github.com/hearsay-tools/cezarion/issues) and tell us. That feedback,
early, is worth more than a bug report six weeks after a release, and it is how
most of the features here got their final shape.

**Know what you're installing.** A nightly is verified (typecheck, unit suites,
packaged-CLI e2e — the same gate a release runs) but it is *not* a release: it
can be rough, a flag or a screen may change under you, and something occasionally
breaks in a way no test caught. Nothing is at risk beyond your patience — every
task runs in its own git worktree and auto merge is off by default — but if you need a
boring day, stay on the stable release. Pin a nightly you liked with its exact
version (`npx -p @hearsay-tools/squawk@<nightly-version> hsq` — the cockpit prints the
version it booted, and the date in it tells you how old the build is), and drop
back to stable any time with a plain `npx -p @hearsay-tools/squawk hsq`.

### Preview builds

Every green CI run also publishes an installable npm snapshot
([how it works](docs/publishing.md)), so you can try code that has not even
merged yet:

```bash
npx -p @hearsay-tools/squawk@dev hsq   # current main head
```

Every pull request gets its own preview too — the CI bot posts a sticky comment
on the PR with the exact pinned version to copy-paste
(`npx -p @hearsay-tools/squawk@<version>-pr<N>.<run> hsq`). Nightlies and previews are all
prerelease versions under their own dist-tags; a plain `npx -p @hearsay-tools/squawk hsq` always
resolves to the latest stable release.

---

## How it works

You describe a task. Squawk runs it as a **workflow** — an ordered list of agent
steps and shell checks — shelling out to your locally installed agent CLI
(Claude Code by default; Codex, OpenCode, Cursor, pi and OMP are drop-in
alternatives, per task or per step). Each task gets its own git worktree; the
cockpit streams every event live and leaves the diff on the task's branch for
you to inspect.

```
   you type a task
        │
        ▼
   ┌─────────────┐   optional: Plan → AI drafts a chain of steps you approve
   │  workflow   │   (agent steps + shell checks, with bounded onFail retries)
   └─────────────┘
        │
        ▼
   ┌──────────────────────────────┐     ┌────────────────────────────────┐
   │  git worktree per task       │     │  agent CLI  (your login)       │
   │  (isolated branch, parallel) │◄───►│  claude · codex · opencode ·   │
   └──────────────────────────────┘     │  cursor · pi · omp             │
        │                               │  Bash open · no prompts        │
        │                               └────────────────────────────────┘
        │  agent text · tool calls · tool results · tokens · cost
        ▼
   ┌─────────────┐   SSE (replay + live)   ┌──────────────────────────┐
   │ .ai/cezar/  │ ──────────────────────► │  cockpit  localhost:4321 │
   │SQLite·NDJSON│                         │  Tasks · Git · GitHub ·  │
   │ ·Markdown   │                         │  Skills · Workflows      │
   └─────────────┘                         └──────────────────────────┘
                                                  │
                                          read the diff → send notes back ·
                                          draft PR · finish
```

When a check fails, the workflow can loop back to an earlier step (bounded by
`max`) with the failing output appended to the retried agent's prompt. By default,
a finished run's changes stay on its branch until you act on them. A task can opt
into merging its PR after Done, subject to current-head CI and GitHub rules.
With the optional review gate on, a run with changes rests in `review` instead
of `done`.

---

## Core concepts

Three words, no jargon — **task**, **skill**, **chain**:

- 📋 **Tasks** are the unit of work. Every task is a **run**: `queued → running →
  review / done / failed / cancelled`, with a live event log, per-step token and
  cost usage, cancel/delete, and — for anything with a diff — a reviewable branch. Attach
  screenshots, PDFs, `.txt` or `.md` files to the task (paperclip, ⌘V or drag-drop;
  the agent gets each one as a real file on disk), or send follow-up messages into
  the live session while it works.
- 📖 **Skills** are Markdown playbooks. Drop them in `.ai/skills/` or
  `.ai/cezar/skills/`, or pull them from a shared **team skills repo** you name
  in `skillsRepos` (a bare git clone cached globally in `<cache>/`). There is no
  default team repo. Add, remove, enable and disable team repos on the **Skills** page,
  which writes `skillsRepos` for you, and each team skill has its own on/off switch per project. A workflow step references one by
  `skill: <name>` and its body becomes the agent's extra system prompt — so you
  shape *how* the agent reasons without touching code.
- 🔗 **Chains (workflows)** stitch steps into a pipeline: agent steps plus shell
  checks, with bounded `onFail` retry loops. Write the YAML yourself, build one by
  drag-ordering skills in the **Workflows** tab, or press **Plan first** and let the
  AI draft a chain for your task that you review, trim and start. The built-in
  `quick-task` (one agent step) works with zero setup.

The moves that make the cockpit worth the browser tab:

- 🗃️ **Queue + orchestration.** Start as many tasks as you like: Squawk runs up to
  `maxParallel` at once across every project (default **2**; a non-git directory
  always runs one, until its first commit lifts that limit within a minute) and
  holds the rest in a FIFO queue with visible positions (`#1`, `#2`, …). Cancel a
  queued task before it starts; the queue even survives a cockpit restart —
  everything still `queued` is re-enqueued in order. It's the orchestration layer
  that turns "one agent at a time" into a backlog that drains itself.
- 🧠 **Memory-aware runs.** Each run's whole process tree is sampled (~2 s) for CPU
  and RSS, and its **peak memory** is recorded and shown in the task table. Set an
  optional per-task **memory ceiling** (`memoryLimitMb`) and a run that crosses it
  is *paused* — freeing its tree so the queue keeps advancing — and resumes on
  demand. Event logs are append-only NDJSON and streamed rather than re-serialized,
  and live UI deltas are coalesced so they never hit disk.
- 🧹 **Bounded worktree disk.** Each task runs in its own full checkout, so a busy
  cockpit would otherwise grow without limit. Squawk keeps only the last
  `worktreeRetention` **finished** worktrees on disk (default **10**; `0` =
  unlimited) and reclaims the rest — directory only, the `cez/<id8>` branch is
  kept, so the work stays recoverable. Once a branch's work is on the base, or
  its exact PR merged, a background sweep deletes the local branch (a task's
  merged PR branch and its unused starter too); unmerged work, open PRs and
  your own branches stay. Settings → Resources shows every
  worktree's disk use with per-row delete and a **Reclaim now** button.
- 🛡️ **You control merging.** Read a finished run's diff, type notes that go
  straight back into the agent's session, or push a `gh pr create --draft`.
  Auto merge is off by default and requires a task to opt in. The **review gate** is optional (`HSQ_REVIEW_GATE=1` (`CEZ_REVIEW_GATE` fallback), or
  Settings → Agents): with it on, a successful run with changes parks in `review`
  until you accept it. Autonomous runs always skip it.
- 🗂️ **Every project in one cockpit.** One `hsq serve` hosts every repo you
  register; the desktop rail switches between them, and **All tasks** shows every
  project's tasks in one table. See
  [Multiple projects, one cockpit](docs/areas/workspace-registry.md#multiple-projects-one-cockpit).
- 👥 **Owned workers.** A task's agent can spawn its own tracked workers — on the
  same or another runner — message them, and collect their diffs; you still review
  the result. Each task has an **Allow Squawk workers** switch, on by default. See
  [Owned workers](docs/workers.md#owned-workers).
- 📱 **Runs on your coding server, drives from your pocket.** The cockpit is a
  responsive web app streaming over SSE, so the box running Squawk can be a
  **VPS, cloud, or dedicated server** you never sit in front of. Point a browser
  — laptop or **phone** — at it and run an **always-on coding team** on the move:
  start tasks, watch them live, and review their diffs from anywhere.

---

## Cockpit tour

Task and project views share one browser window and live updates over Server-Sent Events:

| View | What's in it |
|---|---|
| **Tasks** | Every task with its status, live event stream (agent text · tool calls · tool results · pasted/generated screenshots and file attachments), tokens and cost. Continue, cancel, open in terminal (`claude --resume`), review the diff, or push a draft PR. |
| **All tasks** | Every *registered project's* tasks in one table, filtered and grouped by tag, project, status or workflow — see [Grouping connected repositories](docs/areas/workspace-registry.md#grouping-connected-repositories-tags-and-the-all-tasks-page). Appears once a second project is registered. |
| **Activity** | What each active task and worker does or waits for right now, and the open requests between tasks as lines. Live without a reload. **All projects** shows one panel per project. |
| **Git** | In **More**. Branch, working-tree status, diff vs HEAD, recent commits (click one for its inline patch + GitHub link), and the configurable base branch that worktrees fork from and PRs target. |
| **GitHub** | Open issues and PRs of the repo's origin, read through your logged-in `gh`. Hand an issue straight to the agent — pick a workflow and skills, one click runs it. |
| **Skills** | Local skills plus any team skills repos you configured, each team skill with a per-project switch, and a rendered body + prompt preview. Refresh pulls the latest from the remote. |
| **Workflows** | Build a chain by drag-ordering skills, save it as portable YAML, import/export, or delete. Built-ins always come back. |
| **Settings** | Appearance (dark/light theme, accent, density), agent backends, notifications, and the skills catalog. |

The cockpit is a React app served pre-built from the package — `npx -p @hearsay-tools/squawk hsq`
still means no build step and no dev server on your machine — with a dark/light
theme and a ⌘K command palette.

GitHub issue and PR lists refresh every 60 seconds while mounted in a foreground browser tab.
Automatic reads retain the server's 60-second cache: while online and visible, upstream edits
appear within 120 seconds plus request time. Revisiting or focusing stale data fetches again;
server reconnects invalidate cached lists. Hidden and unmounted lists do not poll. **Refresh**
bypasses the server cache immediately and refreshes the selected thread too.

---

## Multiple projects, one cockpit

See [Multiple projects, one cockpit](docs/areas/workspace-registry.md).

## Waiting for PR checks, merges and timers

See [Waiting for PR checks, merges and timers](docs/waits.md).

## Discover runners and models

Inspect the same host catalog the cockpit uses before selecting a runner or model:

```sh
hsq discover runners
hsq discover models --runner=codex
```

Both commands return JSON. `runners` lists connection status (`connected`, `disconnected`, `not-installed`, or `unknown`) and enablement, with `scope: "host-default-account"`. Model rows include `effortLevels` when the runner advertises them: an absent field means unknown; an empty array means no advertised levels. Omit `--effort` when spawning to keep the existing default. Model responses retain `source`, `stale`, and any unavailable `reason`; discovery never invents model IDs or effort support.

For operators, the command finds the running cockpit for the current checkout; `--repo`, `--url`, and `HSQ_URL` (`CEZ_URL` fallback) work as they do for `hsq task`. A missing cockpit returns an error and never starts a server. Inside a parent delegation session, the same command uses that session's authenticated controller, including headless runs. It rejects `--url` and `--repo` in that context and never falls back to a public cockpit after an authentication failure. Owned workers cannot use the private discovery route.

The catalog describes host default accounts, not every named account or the selections permitted by a task's model locks and workflow pins.


## Owned workers

See [Owned workers](docs/workers.md).

## From the terminal: `hsq task` and `hsq message`

See [From the terminal: `hsq task` and `hsq message`](docs/areas/cli.md).

## Workflow format

See [Workflow format](docs/areas/workflows.md).

## How it runs agents

Squawk shells out to your locally installed, logged-in agent CLI —
**your subscription, no API key**. With the default Claude Code backend that
means headless `stream-json` mode, tool access via `--allowedTools`, with
unapproved tools denied without prompting (`--permission-mode dontAsk`) inside
the task's worktree — but note the zero-config default list (`Read`, `Edit`,
`Write`, `Grep`, `Glob`, `Bash`) grants unrestricted `Bash` unless a step sets
`bashAllowlist`, so treat a run as having full shell access in its worktree,
not a sandboxed allowlist. Set `HSQ_APPROVAL_GATE=1` (`CEZ_APPROVAL_GATE` fallback) to opt into Claude's
interactive approval UI. Codex, OpenCode and Cursor are driven through their
own native protocols and don't honor `allowedTools` at all; OpenCode's own
permission config decides what it asks. pi and OMP map `allowedTools` onto
their own tool allowlists — see
[Coding agent backends](#coding-agent-backends) for what each one actually
locks down. Nothing runs on a server you don't own.

Live Preview lets Chromium use host graphics when available. Chromium selects the
backend and falls back to software when hardware is unavailable or blocked. This
needs no Squawk setting or VirGL-specific setup. On Linux, GPU access may also
need a working display in the cockpit process environment. JPEG streaming is
unchanged; GPU rendering does not guarantee hardware frame encoding.

Useful environment variables:

| Var | Effect |
|---|---|
| `HSQ_*` settings (`CEZ_*` fallback) | Ordinary settings prefer a defined HSQ value, including empty. Home, hosted-mode REMOTE and native shell controls use the separate rules below. Both home locators and inherited controller authority are removed from child environments, even in full-env mode. |
| `CEZ_DELEGATION` | Retired (hearsay-tools/cezarion#2784); has no effect. Workers and task messaging are per-task settings, both on by default. See [Owned workers](docs/workers.md#owned-workers). |
| `HSQ_DELEGATION_URL`, `CEZ_DELEGATION_URL`, `HSQ_DELEGATION_TOKEN`, `CEZ_DELEGATION_TOKEN` | Internal generated session values; do not configure or copy them. Tokens rotate on Continue/restart and are revoked when the session/controller closes. |
| `HSQ_REMOTE`, `CEZ_REMOTE` | Hosted mode: exact `1` under either name disables local handoff and local settings administration. Empty or `0` cannot cancel the other name's hosted-mode pin. Server installers pin both names. |
| `HSQ_API_PORT`, `CEZ_API_PORT` | Local service port used by the development web proxy; defaults to 4321. |
| `HSQ_CODEX_NETWORK`, `CEZ_CODEX_NETWORK` | Codex sandbox network access: exact `0` disables it. |
| `HSQ_CODEX_REASONING`, `CEZ_CODEX_REASONING` | Codex reasoning summary: auto (default), concise, detailed or none. |
| `HSQ_RELEASE_CHANNEL`, `CEZ_RELEASE_CHANNEL` | Explicitly requests `nightly` in `release-snapshot.mjs`. Other nonempty values, including `stable` and `development`, publish nothing. When unset or empty, the event selects development snapshots. `release.mjs` selects stable releases through its bump argument. |
| `HSQ_RELEASE_ROOT`, `CEZ_RELEASE_ROOT` | Repository root containing the package manifests that `release.mjs` reads and stamps. |
| `HSQ_SNAPSHOT_ROOT`, `CEZ_SNAPSHOT_ROOT` | Repository root containing the package manifests that `release-snapshot.mjs` reads and stamps. |
| `HSQ_ALLOW_TEST_SPAWN`, `CEZ_ALLOW_TEST_SPAWN` | Test harness opt-in for real agent process spawning. Leave unset outside tests. |
| `HSQ_ARTIFACTS_DIR`, `CEZ_ARTIFACTS_DIR`, `HSQ_HANDOFF_FILE`, `CEZ_HANDOFF_FILE`, `HSQ_TASK_ID`, `CEZ_TASK_ID`, `HSQ_PROJECT_ROOT`, `CEZ_PROJECT_ROOT` | Internal task paths and identity generated by the controller. Do not configure them. |
| `HSQ_TOOL_SOCKET`, `CEZ_TOOL_SOCKET`, `HSQ_TOOL_TOKEN`, `CEZ_TOOL_TOKEN` | Internal tool transport authority generated for each session. Do not configure or copy it. |
| `HSQ_AUTOSAVE_OWNER`, `CEZ_AUTOSAVE_OWNER` | Internal process attribution markers. Do not configure them. |
| `HSQ_DESKTOP`, `CEZ_DESKTOP`, `HSQ_SUPERVISED`, `CEZ_SUPERVISED`, `HSQ_SUPERVISOR_PID`, `CEZ_SUPERVISOR_PID`, `HSQ_SUPERVISOR_STDIN`, `CEZ_SUPERVISOR_STDIN` | Internal desktop and supervisor lifecycle values. The shell's CEZ value wins when present, including empty values; HSQ is used only when CEZ is absent. Do not configure them. |
| `HSQ_DISCLAIM_EXEC`, `CEZ_DISCLAIM_EXEC` | Desktop executable used to remove inherited macOS execution attribution. A defined CEZ value wins over HSQ. Discovered automatically. |
| `HSQ_DESKTOP_ENTRY` / `CEZ_DESKTOP_ENTRY` | Native-shell development entry file. The HSQ name wins when present, including an empty value. |
| `HSQ_DESKTOP_CWD` / `CEZ_DESKTOP_CWD` | Native-shell starting project directory. The HSQ name wins when present. |
| `HSQ_DESKTOP_NODE` / `CEZ_DESKTOP_NODE` | Native-shell Node executable. The HSQ name wins when present. Empty selects `node` on PATH. |
| `HSQ_DESKTOP_NO_UPDATE=1` / `CEZ_DESKTOP_NO_UPDATE=1` | Disable signed native-shell updates. The HSQ name wins when present. Debug builds already disable updates. |
| `HSQ_DESKTOP_DEBUG_IPC` / `CEZ_DESKTOP_DEBUG_IPC` | Debug builds only: exercise native title-bar IPC after loading the cockpit. The HSQ name wins when present. |
| `HSQ_URL`, `CEZ_URL` | Cockpit origin for `hsq task` and operator `hsq discover` (e.g. a hosted `HSQ_REMOTE`, `CEZ_REMOTE` cockpit). Unset, they find the local cockpit serving this checkout on ports 4321–4370. Parent discovery uses its delegation controller instead. |
| `HSQ_COCKPIT_URL`, `CEZ_COCKPIT_URL`, `HSQ_PROJECT_ID`, `CEZ_PROJECT_ID` | Set by the cockpit in every agent's environment once it listens: the bound origin and the run's project. `hsq automation` calls that address; a headless `hsq run` sets neither. Do not configure them. |
| `HSQ_DRY_RUN=1`, `CEZ_DRY_RUN=1` | Use bundled mocks for all five agent backends — the cockpit works offline for demos and development. Explicit backend binary overrides still win. |
| `HSQ_AGENT_MODELS_LOCKED=1`, `CEZ_AGENT_MODELS_LOCKED=1` | Globally lock each runner to the model configured in its native Claude/Codex/OpenCode settings while keeping runner selection available. Exact `1` also delegates authentication and provider enablement to those native agents, so Squawk skips its credential probes and provider-disable preferences. Existing Squawk presets are preserved but ignored, and an environment change requires a restart. The config-file equivalent is `"modelsLocked": true` in global `<config>/config.json` or one repository's `.ai/cezar/config.json`; config-file locks do not disable provider checks. |
| `HSQ_APPROVAL_GATE=1`, `CEZ_APPROVAL_GATE=1` | Opt into Claude's interactive approval UI; by default, unapproved tools are denied without interrupting the run. Ignored when `HSQ_CLAUDE_PERMISSION_MODE`, `CEZ_CLAUDE_PERMISSION_MODE` is a recognized value (`dontAsk`, `acceptEdits`, or `bypass`). |
| `HSQ_CLAUDE_PERMISSION_MODE`, `CEZ_CLAUDE_PERMISSION_MODE` | Claude agent-run permission flag: `dontAsk` (default), `acceptEdits`, or `bypass`. `bypass` passes `--dangerously-skip-permissions` and omits `--permission-mode`. Unset or unknown keeps today's `dontAsk` / `HSQ_APPROVAL_GATE`, `CEZ_APPROVAL_GATE` path. Provider verification commands are never given this flag. |
| `HSQ_CLAUDE_SETTING_SOURCES`, `CEZ_CLAUDE_SETTING_SOURCES` | When set, Claude agent runs also pass `--setting-sources <value>` (e.g. `user,project,local`). Unset or empty omits the flag. Provider verification is never given this flag. |
| `HSQ_ARCHIVE_ON_MERGE=1`, `CEZ_ARCHIVE_ON_MERGE=1` | Archive settled task families after all associated pull requests merge. Off by default; only `1` enables this environment default. Saved project settings override global Tasks settings, which override the environment. Runs in the background while the cockpit is open, including unopened projects, without starting agents. Unarchive preserves restored tasks until a later merge. |
| `HSQ_AUTOMATIONS=0`, `CEZ_AUTOMATIONS=0` | Disable **automations** (GitHub polls and schedules). On by default; only the exact value `0` disables them. Unset, empty, `1` and other values keep them on. The Automations view and agent schedule tools are available by default. New automations start paused; each enabled automation launches an ordinary task per match or occurrence while Squawk is open. Schedules need no GitHub remote. With `0`, nothing polls or fires, automation endpoints answer `409`, and the nav item and schedule tools are hidden. Read at boot: restart after changing it. Existing enabled definitions resume after an upgrade unless you set `HSQ_AUTOMATIONS=0`, `CEZ_AUTOMATIONS=0` before restart. Definitions, receipts and high-watermarks are retained; unset the flag and restart to resume without migration. |
| `HSQ_PREVIEW=1`, `CEZ_PREVIEW=1` | Turn on **live preview** (experimental): agents register a dev server with the `cezar_preview_serve` tool, and the cockpit opens it in a headless Chromium on the host, docked next to the task. Squawk first runs a registered command after you press Run and open. Agents can then use `cezar_preview_stop({ port, restart?: boolean })` to stop or restart their own Squawk-started server with that unchanged approval; changed command, cwd or path needs Run and open again. Adopted servers cannot be stopped by this tool. Each agent session also gets `HSQ_PREVIEW_CDP_URL`, `CEZ_PREVIEW_CDP_URL`, a cockpit address through which it drives the same browser (`agent-browser --cdp "$CEZ_PREVIEW_CDP_URL" --pin-tab …`) while you watch; Chromium itself opens no debug port. Off by default, and only the exact value `1` enables it — without it the tool is not listed, its route and the preview WebSocket refuse, and `capabilities.preview` is `false`. Read at boot, so restart after changing it. |
| `HSQ_PREVIEW_NO_SANDBOX=1`, `CEZ_PREVIEW_NO_SANDBOX=1` | Launch the preview's Chromium with `--no-sandbox`. Off by default and never added automatically, not even for root or in a container; use it only where Chromium's sandbox cannot start, and only for pages you trust. Only the exact value `1` applies. Read at boot. |
| `HSQ_AUTOSAVE=1`, `CEZ_AUTOSAVE=1` | Re-enable the periodic (90 s) autosave commit in task worktrees. Off by default (open-mercato/cezar#471) — turn-end and pre-PR flushes always run, so branches still end complete. Every autosave names its trigger in the commit subject (`cezar autosave (periodic)` vs `(turn end)` / `(run finalize)` / `(pre-PR)`), so the flushes you keep are distinguishable from the timer you disabled. The turn-end / run-finalize flushes and the timer commit only while HEAD is the task's own `cez/<id8>` branch; on a branch the agent checked out they leave the work uncommitted, and the closing flush says so in the handoff's Squawk records block, not its Progress log (hearsay-tools/cezarion#1004, hearsay-tools/cezarion#1809). A turn-end / run-finalize commit is reported there too, with its `git reset --soft` fold-back command, and the timer's commits share one line per run of consecutive periodic commits (count, first and latest sha), with no cockpit note. Draft-PR publish refuses while HEAD is not on the task branch and names both branches; its pre-PR flush commits only onto that branch (hearsay-tools/squawk#1110). |
| `HSQ_CLAUDE_BIN=/path/to/claude`, `CEZ_CLAUDE_BIN=/path/to/claude` | Override the Claude executable for model discovery and execution. A set `HSQ_CLAUDE_BIN` wins over `CEZ_CLAUDE_BIN`; an explicit binary argument wins over both. |
| `HSQ_CODEX_BIN=/path/to/codex`, `CEZ_CODEX_BIN=/path/to/codex` | Override which `codex` binary is used. |
| `HSQ_OPENCODE_BIN=/path/to/opencode`, `CEZ_OPENCODE_BIN=/path/to/opencode` | Override which `opencode` binary is used. |
| `HSQ_PI_BIN=/path/to/pi`, `CEZ_PI_BIN=/path/to/pi` | Override which `pi` binary is used. |
| `HSQ_OMP_BIN=/path/to/omp`, `CEZ_OMP_BIN=/path/to/omp` | Override which `omp` (Oh My Pi) binary is used. |
| `HSQ_CURSOR_BIN=/path/to/agent`, `CEZ_CURSOR_BIN=/path/to/agent` | Override the Cursor CLI (`agent`) executable. |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `OMP_PROFILE` | The agents' **own** variables, honoured where the vendor documents one. Setting one moves that agent's **default account** — the config folder (for omp, the profile) Squawk discovers. A *second* login of the same CLI is deliberately not an environment setting, since one process-wide value cannot differ per project: add it under **Settings → Agent accounts** and pick it per project. |
| `HSQ_BROWSE_ROOT=~/`, `CEZ_BROWSE_ROOT=~/` | Default root for **Add project → Open local folder…**. The picker cannot navigate above it; a saved workspace value overrides the environment default and must name an existing folder. |
| `HSQ_PROJECTS_DIR=~/cezar/projects`, `CEZ_PROJECTS_DIR=~/cezar/projects` | Default destination for **Clone from GitHub** and **New project**. Saved workspace settings override it, and missing directories are created recursively. |
| `HSQ_PROJECT_WARMUP=0`, `CEZ_PROJECT_WARMUP=0` | Prepare each registered project only when it is first opened. By default the cockpit prepares every other registered project in the background once it listens, one at a time, most recently opened first: the run store opens and interrupted runs resume, so the first click on a project does not wait. A project another live cockpit serves is skipped. |
| `HSQ_AUTONOMOUS_DEFAULT=0`, `CEZ_AUTONOMOUS_DEFAULT=0` | Seed the New Task Autonomous default (`0` or `1`). Without a seed, skills default on and workflows off; a saved global Resources setting overrides it. |
| `HSQ_WORKTREE_DEFAULT=1`, `CEZ_WORKTREE_DEFAULT=1` | Seed the New Task Worktree default (`0` or `1`). Without a seed, eligible runs default on; a saved global Resources setting overrides it. |
| `HSQ_DISABLE_REPO_LOCK=1`, `CEZ_DISABLE_REPO_LOCK=1` | **Dangerous escape hatch:** allow any run executing in the repository root — an explicit `worktree=false` run, non-Git degradation, or a continuation whose worktree cannot be restored — to proceed without Squawk’s repository-root lease. Agents can overwrite each other’s files or Git state; isolated worktree runs are unaffected. Off by default; only the exact value `1` enables it. |
| `HSQ_HIDE_TOKEN_USAGE=1`, `CEZ_HIDE_TOKEN_USAGE=1` | Hide raw input/output token counts throughout the browser cockpit while leaving backend-reported cost visible. Only the exact value `1` enables it; telemetry and API payloads are unchanged, and a restart is required after changing it. |
| `HSQ_HIDE_COST=1`, `CEZ_HIDE_COST=1` | Hide backend-reported monetary cost throughout the browser cockpit while leaving raw input/output token counts visible. Only the exact value `1` enables it; telemetry and API payloads are unchanged, and a restart is required after changing it. |
| `HSQ_HIDE_TOKEN_METRICS=1`, `CEZ_HIDE_TOKEN_METRICS=1` | Legacy master switch that hides both token usage and cost. It takes precedence over the two independent flags; only the exact value `1` enables it, payloads are unchanged, and a restart is required. |
| `GITHUB_TOKEN` | Fallback for GitHub reads/PRs when `gh` isn't authenticated. |
| `HSQ_HOME=/path/to/home` (`CEZ_HOME` fallback) | Selects `config/`, `state/`, `data/`, `cache/`, and `run/` below this directory. With neither set, uses the [platform roots](docs/migration.md#home-directories). A non-default `CEZ_HOME` keeps its permanent one-root fallback; an explicit legacy-default `CEZ_HOME` uses the platform roots. Both home locators are removed from child environments. |
| `HSQ_ENV_PASSTHROUGH=A,B`, `CEZ_ENV_PASSTHROUGH=A,B` | Forward these extra host env vars to spawned agents. `CEZ_HOME` and `HSQ_HOME` are always removed, including in full-env mode. By default agents get a least-privilege env (safe shell/toolchain vars + the backend's own auth + `GITHUB_TOKEN` + `HSQ_*` and matching `CEZ_*` aliases), not your full environment — use this to add a var an agent needs. A dev server live preview starts gets the same env without the backend's auth and `GITHUB_TOKEN`, plus these names. |
| `HSQ_AGENT_ENV_FULL=1`, `CEZ_AGENT_ENV_FULL=1` | Escape hatch: give spawned agents, and dev servers live preview starts, the full host environment except `CEZ_HOME` and `HSQ_HOME` (pre-hardening behavior). Off by default; only set it if you understand that this hands every host secret to the agent process. |
| `HSQ_AGENT_TMPDIR=0`, `CEZ_AGENT_TMPDIR=0` | Stop giving each task its own temp directory and hand agents the host `TMPDIR` again (pre-open-mercato/cezar#785 behavior). On by default: every run gets `TMPDIR`/`TEMP`/`TMP` pointing at `.ai/cezar/t/<task-id8>` (`.ai/cezar/tmp/<task-id>` before hearsay-tools/cezarion#1022), created and write-probed before the agent spawns, kept across session close, Continue, and restart while the task is live, and reaped at terminal completion or history deletion (hearsay-tools/cezarion#515) — and kept short enough for unix-socket paths: a checkout so deep that `.ai/cezar/t/<task-id8>` would leave no room under the kernel's socket-path limit for Chromium's singleton socket resolves it to a `cez-agent-…` directory under the system temp dir instead (hearsay-tools/cezarion#387), with its location recorded so host temp-environment changes cannot move live scratch. So concurrent tasks stop sharing one directory and a task refuses to start rather than run against a temp directory that silently swallows its shell output (see Troubleshooting below). Only an exact `0` disables it, and it disables the whole thing — the pre-spawn check included, so this stays an escape hatch you can actually take. |
| `HSQ_REDACT_SECRETS=0`, `CEZ_REDACT_SECRETS=0` | Disable scrubbing of credential values/token shapes from the on-disk state (the NDJSON transcript and the free-text fields of the run records in `runs.db`). On by default; leave it on. Controller-generated delegation tokens are always scrubbed. Best-effort defense-in-depth, not a guarantee: it catches known token shapes and the values of your own secret-named env vars, so a credential in neither category can still get through. |
| `HSQ_TITLE_UPDATES=0`, `CEZ_TITLE_UPDATES=0` | Turn off the live task-title refresh (namer re-runs on each turn end). The Settings → Agents toggle overrides this default. |
| `HSQ_AUTONAME=0`, `CEZ_AUTONAME=0` | Disable ALL LLM task naming (creation + live) — titles stay heuristic (`437: /om-auto-review-pr`). Under `HSQ_DRY_RUN=1`, `CEZ_DRY_RUN=1` naming is already off unless forced with `HSQ_AUTONAME=1`, `CEZ_AUTONAME=1`. |
| `HSQ_REVIEW_GATE=1`, `CEZ_REVIEW_GATE=1` | Turn ON the optional diff-first review gate (open-mercato/cezar#489): a successful, non-autonomous run with changes parks at `review` (Accept / Send back / Draft PR) instead of finishing. Off by default — changed runs settle to `done` with the diff left in the worktree. Only `1` enables. The Settings → Agents toggle overrides this; autonomous runs always skip it. |
| `VITE_HSQ_API_BASE=http://localhost:4321`, `VITE_CEZ_API_BASE=http://localhost:4321` | **Build time only**, and only when the cockpit bundle is deployed apart from the service it talks to. Empty (the default) means "the origin that served this page", which is right for both normal cases: the CLI serves the bundle itself, and `npm run dev` proxies `/api` to the local service. A deployment that must be configured without a rebuild can put `<meta name="cez-api-base" content="…">` in the served HTML instead, which wins over this. |
| `VITE_HSQ_E2E=1`, `VITE_CEZ_E2E=1` | **Build time only.** The cockpit e2e suite sets this when it builds the bundle it drives. It pins `useNow` and every `refetchInterval` so a wait cannot span a 30s tick or a 4s poll. Leave unset for production. |

### Troubleshooting: the agent's shell returns nothing

**Symptom.** A task on the Claude backend keeps working, but every shell command
comes back with no output and a spurious non-zero exit status — `echo hello`
included. Redirecting into a file inside the worktree still produces the right
content, so the commands genuinely run; only the *capture* is lost. Codex tasks
on the same machine are unaffected, because that backend streams over stdio
pipes instead of round-tripping a command's output through a temp file.

**Diagnosis.** The temp directory the agent was given is out of space or out of
quota. One line tells you:

```bash
echo probe > "${TMPDIR:-/tmp}/probe"   # "Disk quota exceeded" / "No space left on device"
df -i "${TMPDIR:-/tmp}"                # a tmpfs can exhaust inodes long before bytes
```

Under quota the file is *created* and the write then fails, so the backend reads
back a zero-byte capture file and hands the agent an empty result.

**Fix.** Since open-mercato/cezar#785 Squawk gives each task its own `TMPDIR` under
`.ai/cezar/t/<task-id8>` and write-probes it before spawning, so a broken temp
directory fails the task with `agent temp directory is not writable: …` on the
task thread instead of corrupting its work. If you see that error, free space on
the disk holding the repo. `HSQ_AGENT_TMPDIR=0` (`CEZ_AGENT_TMPDIR` fallback) turns the whole mechanism off —
per-task directory and pre-spawn check alike — and hands agents the host
`TMPDIR` again, which is the way out if the check itself is wrong on your
platform.

### Troubleshooting: tools inside a task fail with a socket-path error

**Symptom.** Inside a task, `npm install`, `npm run typecheck`, or another tool
dies with `listen EINVAL` or a "socket path too long" / `ENAMETOOLONG` error —
with `TMPDIR=/tmp` set by hand, the same commands succeed. Tools like `tsx` bind
*named* unix sockets under `TMPDIR` (its IPC server builds
`<tmpdir>/tsx-<uid>/<pid>.pipe`), and the kernel caps a socket path at 104–108
bytes — a temp directory near that length leaves no room for the name.

**Fix.** Since hearsay-tools/cezarion#387 Squawk keeps each task's temp directory short
enough for these sockets: at most 58 bytes since hearsay-tools/cezarion#1022, which
leaves room for Chromium's `<tmpdir>/org.chromium.Chromium.XXXXXX/SingletonSocket`
on macOS's 104-byte limit. The repo-local directory is `.ai/cezar/t/<task-id8>`
(the first 8 characters of the task id), short enough for ordinary checkouts such
as `/home/<user>/projects/<repo>`. A checkout deep enough to push it past the limit
gets a short `cez-agent-…` directory under the system temp directory instead —
still per-task, still write-probed before the agent spawns, still reaped when the
run ends.
`HSQ_AGENT_TMPDIR=0` (`CEZ_AGENT_TMPDIR` fallback) reverts the whole mechanism to the host `TMPDIR`.

---

## Coding agent backends

Squawk is not married to one vendor. Every agent step runs through a single
`AgentRunner` seam with six built-in backends:

| Backend | CLI | How Squawk drives it | Tool access |
|---|---|---|---|
| **Claude Code** (default) | [`claude`](https://github.com/anthropics/claude-code) | Headless `stream-json` mode. | Per-tool `--allowedTools` (`bashAllowlist` scopes `Bash`); an empty `allowedTools` sends `--tools ""`, which removes every built-in tool, and pre-approves Squawk's own tools (other MCP tools follow the permission mode); `dontAsk` denies unapproved tools without prompting (`HSQ_APPROVAL_GATE=1` (`CEZ_APPROVAL_GATE` fallback) → `acceptEdits` + approval UI; `HSQ_CLAUDE_PERMISSION_MODE=bypass` (`CEZ_CLAUDE_PERMISSION_MODE` fallback) → `--dangerously-skip-permissions`). |
| **Codex** | [`codex`](https://github.com/openai/codex) | `codex app-server` — JSON-RPC over stdio, the same transport the Codex IDE extensions use. | Ignores `allowedTools`; inherits managed permissions and Codex approval defaults. Confirmed unmanaged sessions use `danger-full-access`. `HSQ_CODEX_NETWORK=0` (`CEZ_CODEX_NETWORK` fallback) requires network restriction: unmanaged sessions use network-blocked `workspace-write`; managed filesystem rules remain intact, and an unconfirmed network restriction stops before any turn. If requirements discovery is unavailable, Codex permission defaults apply. |
| **OpenCode** _(experimental)_ | [`opencode`](https://opencode.ai) | `opencode serve` — a local HTTP server with an SSE event stream. | Ignores `allowedTools` entirely; OpenCode's own permission config governs. Squawk answers OpenCode's built-in asks (outside-worktree reads, `.env` reads, the repeated-call guard) once, unless your config has a rule for that permission. Any other ask shows a permission card in the cockpit, and the run waits for your answer. |
| **Cursor** | [`agent`](https://cursor.com/docs/cli/installation) | Resumable `--print --output-format stream-json` turns on a qualified build; an unqualified build fails the task before inference. | Print mode admits marketplace plugins, including user and team plugins. Per-run `allowedTools` and `bashAllowlist` are unsupported. |
| **pi** _(experimental)_ | [`pi`](https://github.com/badlogic/pi-mono) | Persistent `--mode rpc` over JSONL; models are picked with the `provider/model` convention. | Maps `allowedTools` onto pi tool names. The default list, which adds the harness extras `Subagent`, `SubagentSupervisor` and `SubagentWait`, sends no allowlist: `--no-builtin-tools` plus a bundled extension that activates those built-ins, so MCP servers (`direct`, `codemode` and `deferred` exposure) and other pi extensions' tools stay callable. The six base tools alone, the list a worker inherits from a Claude parent, take the same path. A narrowed `allowedTools`, or one that names any tool outside that default set (an `mcp__` tool, `WebFetch` or a custom tool), uses pi's `--tools` allowlist, so a step that grants named tools reaches only those; a list that maps to nothing becomes `--no-tools` (or only the Squawk tools). A configured `bashAllowlist` disables Bash because pi cannot express command-prefix rules. |
| **OMP** _(experimental)_ | [`omp`](https://github.com/can1357/oh-my-pi) | Persistent `--mode rpc` over JSONL (Oh My Pi, a pi fork); models use the `provider/model` convention and are discovered from `omp models --json`. | Maps `allowedTools` onto OMP's `--tools` allowlist (`[]` becomes `--no-tools`); default sessions also pass `todo`, `lsp`, `ast_edit`, `task` and `wait`. A configured `bashAllowlist` disables `bash` because OMP cannot express command-prefix rules. `--tools` filters built-in tools only, so MCP and extension tools stay callable under a narrowed list. |

> ⚠️ **OpenCode, pi and OMP support are experimental.** These runners work but are less
> battle-tested than the Claude Code and Codex backends, and OpenCode ignores
> `allowedTools` (its own permission config governs what it asks). Treat them as
> previews and expect rough edges.

On startup Squawk probes which CLIs are installed and the cockpit only offers
the backends it found — install any one of the six and you're operational.

### Cursor CLI

Install [Cursor CLI](https://cursor.com/docs/cli/installation) and run `agent login`,
or set `CURSOR_API_KEY`. Squawk discovers `agent` on PATH; `HSQ_CURSOR_BIN` (`CEZ_CURSOR_BIN` fallback) overrides
its location. Select **Cursor** in the runner picker. On build
`2026.10.01-e373342` or newer, new sessions use print mode so marketplace plugins
are available. Squawk checks `agent --version` and the native tool catalog before
the first turn; `agent --version` is also the quick way to check your installation.
Squawk starts the CLI with `--disable-auto-update`, so a task never updates it;
update it yourself with `agent update`. An older build, or a build missing a core
tool, fails the task before any inference, with the reason and the fix: run
`agent update`, or update Squawk if your build is newer than it supports.
ACP-tagged and untagged Cursor sessions cannot resume after ACP removal: Continue
on one reports that, and you start a new task to carry the work on. Existing
print-tagged sessions can still resume.
A missing CLI leaves the other backends available. `HSQ_DRY_RUN=1` (`CEZ_DRY_RUN` fallback) uses the mock.
Cursor questions from a plugin may be automatically skipped by print mode. Squawk's
own `cezar_ask` questions remain answerable in the cockpit; plugins that require
native questions may not work fully. Project-local Claude plugin settings may
not disable a user or team marketplace copy. A previously confirmed Cursor
session ID can also lose history inside Cursor without an error; Squawk resumes
the recorded ID and checks that Cursor returns the same ID.
Cursor provides no qualified token-usage telemetry; Squawk leaves usage unavailable
instead of estimating it. Squawk discovers Cursor's canonical model IDs and advertised
effort levels through Cursor's read-only ACP model catalog (`agent acp`), which opens
no session. Print mode accepts those IDs and applies effort using a complete native
parameter selection passed with `--model`, retaining the account catalog's defaults for
other parameters. Advertised legacy print variants remain supported. An unsupported
explicit effort fails instead of silently choosing another level.

Settings → Agent config exposes Cursor’s global `cli-config.json`, project
`.cursor/cli.json` permissions, `.cursor/mcp.json`, and shared `AGENTS.md`.
[Cursor’s configuration reference](https://cursor.com/docs/cli/reference/configuration)
documents `CURSOR_CONFIG_DIR` and the Linux/BSD `XDG_CONFIG_HOME/cursor` override.
These select configuration; Squawk does not offer alternate Cursor account profiles
because a complete credential-and-session home override has not been verified.

### OMP (Oh My Pi)

Install [OMP](https://github.com/can1357/oh-my-pi) (`curl -fsSL https://omp.sh/install | sh`
installs a prebuilt binary; Bun is needed only for `--source`) and run `omp login`. Squawk discovers `omp` on PATH;
`HSQ_OMP_BIN` (`CEZ_OMP_BIN` fallback) overrides its location. `omp` is a separate backend from `pi`: a host with
both binaries keeps both, and `HSQ_PI_BIN` (`CEZ_PI_BIN` fallback) never selects OMP. Select **OMP** in the runner
picker to use a persistent `--mode rpc` session. A missing CLI leaves the other backends
available and shows OMP as unavailable. `HSQ_DRY_RUN=1` (`CEZ_DRY_RUN` fallback) uses the mock.

Agents ask questions through Squawk's `cezar_ask` tool, and OMP's own sub-agents appear in the
Agents drawer. Settings → Agent config exposes OMP's `config.yml`, `mcp.json` and
`AGENTS.md` files. Named OMP profiles and accounts are not supported yet.

**Pick a backend at three levels** (most specific wins):

1. **Config default** — `"defaultRunner": "codex"` in `.ai/cezar/config.json`.
2. **Per task** — the backend picker next to the task box in the cockpit.
3. **Per workflow step** — `runner:` on any step in the YAML.

Per-step overrides are what make **mixed-agent strategies** a one-liner:
implement with one agent, review with another, and let a shell check referee:

```yaml
name: implement-and-cross-review
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
    runner: codex                # one vendor writes the code…
    effort: medium               # …with a cheaper reasoning pass
  - id: review
    name: Cross-review
    prompt: "Review the diff produced for: {{task}}. Fix real issues only."
    runner: claude               # …another one reviews it
    effort: high                 # …with more reasoning for review
  - id: verify
    name: Verify
    command: "npm test"
    onFail: { retry: implement, max: 2 }
```

Owned workers can compare approaches in separate worktrees. Each worker has its own
runner and model selection; see [Owned workers](docs/workers.md#owned-workers).

**Models come from your own machine.** For Claude, Codex, OpenCode, and Pi, the model picker
is not a list Squawk ships — it asks the installed CLI what it can actually run
(Claude stream-json `list_models`, `codex app-server`'s `model/list`,
`opencode models`, and `pi --list-models`), caches the answer in
memory for five minutes, and shows it. A model your provider rolled out
yesterday is selectable without a Squawk release, and one it retired stops being
offered. Claude discovery starts no model turn and uses safe mode with no session
persistence. It has a 15-second deadline and a 200-model cap, with child cleanup
on every outcome. Unsupported or unavailable Claude CLIs fall back to the
`opus`, `sonnet`, and `haiku` aliases. `auto` (let the agent decide) is always
available, including when the CLI is missing, logged out, or slow — discovery
never blocks the cockpit, and a model you pinned yourself stays selectable even
if it is absent from the discovered list.

The seam is deliberately small: a backend is one class implementing the
`AgentRunner` interface (`packages/cezar/src/core/agent-runner.ts`) that turns a prompt into
a stream of normalized events. Other CLIs — pi, aider, whatever ships next —
can slot in the same way.

---

## Desktop app

Squawk Desktop is a Tauri 2 app for macOS, Windows and Linux. Start a local cockpit
or connect to a remote HTTPS cockpit (loopback HTTP supports SSH tunnels). Remote
windows have no native command permissions and need no local Node or agent install.
Local mode needs Node.js 24.21.0+ and npm, then installs `@hearsay-tools/squawk` on first use.

See [desktop installation, development and testing](docs/desktop.md). PR builds
provide test installers; public releases require platform signing and notarization.

## Remote access (host Squawk on a server)

Squawk runs on `localhost` by default. To reach the cockpit from another machine —
a shared team box, a VPS, your phone — put an **authenticated public front** in
front of it. The built-in installer does this interactively, per **platform
strategy**, and never escalates silently: every privileged command is printed
and verified, and it ends with a real authenticated end-to-end check.

```bash
npx -p @hearsay-tools/squawk hsq server-install   --platform ubuntu-vps   # stand it up
npx -p @hearsay-tools/squawk hsq server-deploy    --platform ubuntu-vps   # roll out a new version (reload the service)
npx -p @hearsay-tools/squawk hsq server-uninstall --platform ubuntu-vps   # reverse it

# host a SECOND cockpit for another domain on the same box (ubuntu-vps):

npx -p @hearsay-tools/squawk hsq server-install   --platform ubuntu-vps --domain shop.example.com
```

On `ubuntu-vps` a single host can run several independent cockpits — add
`--domain <host>` and each gets its own port, nginx site, login and service; a
new domain never resumes or clobbers the first install.

**Already running a reverse proxy?** If Dokploy, Coolify, Caddy or your own
nginx already owns `:80/:443`, Squawk's would fight it for the ports. Install the
service only and let your proxy front it:

```bash
npx -p @hearsay-tools/squawk hsq server-install --platform ubuntu-vps \
  --external-proxy --domain Squawk.example.com --bind-host 172.17.0.1
```

`--bind-host` is only needed when the proxy runs in a **container** (Traefik
can't reach the host's loopback); a host-installed proxy uses the `127.0.0.1`
default. In this mode **your proxy must enforce authentication** — Squawk has
none of its own. [Details →](docs/server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy)

| Provider | `--platform` | Public front | Guide |
|----------|--------------|--------------|-------|
| Ubuntu / Debian VPS | `ubuntu-vps` | nginx + Let's Encrypt HTTPS, htpasswd login, systemd | [Step-by-step →](docs/server-install/ubuntu-vps.md) |
| Ubuntu + existing proxy | `ubuntu-vps --external-proxy` | your Dokploy/Traefik/Caddy front; Squawk ships the service only | [Step-by-step →](docs/server-install/ubuntu-vps.md#the-box-already-has-a-reverse-proxy-dokploy-coolify-caddy) |
| macOS + ngrok | `macosx-ngrok` | ngrok tunnel + `--basic-auth`, launchd | [Step-by-step →](docs/server-install/macosx-ngrok.md) |

See the **[Remote access overview](docs/server-install/README.md)** for how it
works and how to redeploy new versions. A remote cockpit keeps Agent config and
worktree setup read-only; to edit them from the browser, see
**[Remote settings administration](docs/server-install/remote-settings.md)**.

---

## Reviewing task files

File links in task messages open the Files tab at the selected file, rather than
navigating to a host path under the cockpit URL. The selection stays in the URL,
so bookmarks and browser Back work. This works with local and remote cockpits.

For a deliverable outside the project, an agent must explicitly publish a snapshot:

```sh
hsq artifact publish /tmp/decision.md
```

An agent starts a long command, such as a benchmark or a full test run, with `hsq job start`:

```sh
hsq job start bench -- npm run benchmark
hsq job status bench
```

The command keeps running after the agent's shell call, turn and session end. It prints the
paths of its log file and its exit-code file, which are in the task's temp directory unless
`--dir` names another one. The agent waits for it with a process wait. A second start of a
name that still runs is refused.

Squawk supplies the bundled command and task context to agent sessions automatically
(`HSQ_TASK_ID` (`CEZ_TASK_ID` fallback) and `HSQ_ARTIFACTS_DIR` (`CEZ_ARTIFACTS_DIR` fallback); do not configure these yourself). The command
returns JSON with a Markdown link for the agent to share. When the owning project
is registered, the link keeps that project when copied or opened from another
project. If ownership cannot be discovered, publication keeps the legacy task link.
The Files tab also lists published artifacts. It previews text, Markdown and raster
images; other formats can be downloaded. Published HTML links in assistant replies also
show report cards. **Read report** opens the sandboxed reader beside the conversation
on wide screens, in the main area on medium screens, and full screen on phones.
Back returns to the source card. Unopened cards fetch metadata only.
Report scripts never execute, and embedded images in Markdown documents do not load
automatically.

Snapshots do not change when the original file changes. They survive worktree
removal and are removed with task history, including normal history retention.
Publication is limited to 10 MiB per file, 64 snapshots and 64 MiB per task; reaching
a limit refuses the new publication without evicting earlier files. There is no
arbitrary host-file reader or automatic collection of mentioned paths. Publish
only intended review material, never credentials or unrelated private files.

## Configuration (optional)

Zero config is the default — everything below is opt-in via the project's
`config.json` in `.ai/squawk/` (`.ai/cezar/` before the project moves). A missing
or malformed file uses the defaults, a bad value falls back to its own default,
nothing blocks startup, and the cockpit never saves over a file that is not valid
JSON:

```jsonc
{
  "skillsRepos": [], // team skills; none by default. Example: [{ "repo": "open-mercato/skills", "ref": "main" }]
  // Team-skill repos are code-trusted: a skill body becomes an agent system prompt.
  // Only owner/name, https/ssh URLs, or local paths (`/abs`, `./rel`, `~/dir`,
  // `C:\dir`) are accepted — no ext::/fd:: transport helpers. Write a relative
  // path as `./name`, not a bare `name`. Pin `ref` to a full commit SHA to freeze
  // the source against a moving branch head — Squawk verifies it resolves to
  // exactly that commit, and reports it as `team.commit`. `"enabled": false` keeps
  // a source listed but loads none of its skills. The Skills page edits this list,
  // keeps every other key, and refuses to write a file it cannot read.
  "worktreeRetention": 10,   // keep the last N finished worktrees on disk; 0 = unlimited (no reclaim, no branch sweep)
  "defaultRunner": "claude", // agent backend: "claude" (default) · "codex" · "opencode" · "cursor" · "pi" · "omp"
  "modelsLocked": true,      // optional: native per-runner model is fixed/read-only; runner stays selectable
  "plannerModel": "sonnet",  // model the "Plan first" button uses to draft chains
  "baseBranch": "develop",   // branch worktrees fork from + PRs target (also settable in the Git view)
  "worktreeSetup": { "commands": ["npm ci"] }, // prepare each new worktree before the agent starts (below)
  "worktreeTeardown": { "commands": ["docker compose down"] } // stop a worker worktree's own services before destroy (below)
}
```

Put the same `"modelsLocked": true` key in `<config>/config.json` to apply it
to every registered project. When the key is absent or `false` in both config
files (and `HSQ_AGENT_MODELS_LOCKED` (`CEZ_AGENT_MODELS_LOCKED` fallback) is not `1`), each runner's normal model
selector uses that runner's discovered model list. While locked, the model is
shown read-only and follows the selected runner's native settings; the runner
itself remains selectable.

Run data (`runs.db` and its `-wal`/`-shm` files, the `runs.json.pre-sqlite*.bak`
backups, NDJSON event logs, worktrees, `todos.json`) is git-ignored
automatically; your workflows and skills stay committable. See [run history recovery](https://github.com/hearsay-tools/cezarion/blob/main/docs/run-history-recovery.md) for backup and repair steps.

Settings that belong to *you* rather than to a repo — the parallel cap
(`maxParallel`, default **2**), the per-task memory ceiling and the checkout
root — live once in `<config>/config.json`, alongside the
[project registry](docs/areas/workspace-registry.md#multiple-projects-one-cockpit), and are edited from
**Settings → Resources** and **Settings → Projects**. A `maxParallel` left over
in a repo's `.ai/cezar/config.json` is imported into the workspace file the
first time Squawk boots there, and ignored afterwards.

### Session-start context

Every session Squawk launches — a fresh step, a retry, **Continue**, recovery, an owned
worker — opens with the run's whole handoff file, so the agent has its notes without a tool
call. Add your own context, such as a vision document, with an optional
`.ai/cezar/context.yaml`:

```yaml
version: 1
rules:
  - id: project-vision
    on: session_start
    target: both          # parent · worker · both
    template: |
      Project vision:
      {{file:docs/vision.md}}
```

The whole prefix is capped at 64 KiB, blocks that do not fit are skipped whole, and each launch
logs which blocks it applied or skipped. See [docs/context-injection.md](docs/context-injection.md)
for the variables, the limits and the error handling.

### Preparing new worktrees

Every task and worker runs in a fresh worktree, and a fresh worktree has nothing installed. Give
the project a `worktreeSetup` and Squawk runs those commands in each new worktree before the
agent's first turn, so the agent (and anything that runs beside it, such as a test watcher)
starts in a ready tree:

```jsonc
// .ai/squawk/config.json (.ai/cezar/config.json before the project moves)
"worktreeSetup": {
  "commands": ["npm ci", "cp \"$HSQ_PROJECT_ROOT/.env\" .env"],
  "timeoutSeconds": 900 // optional, per command; default 900, max 7200
}
```

Or edit it in **Settings → Worktrees → Prepare new worktrees**, one command per line. These are
commands the host runs, so a hosted cockpit (`HSQ_REMOTE=1` or `CEZ_REMOTE=1`) shows it read-only until the host
operator runs `hsq remote-settings enable` ([Remote settings administration](docs/server-install/remote-settings.md)).

- **When it runs.** In every new task worktree and every worker worktree, and again when Continue
  rebuilds a worktree that retention reclaimed. Never for a task that runs in the repo working
  tree (worktree off), and never for a non-git directory.
- **How it runs.** Each command runs as `bash -lc '<command>'` in the worktree root, in order,
  and the setup stops at the first command that fails or times out. Up to 20 commands.
- **What it can see.** The same curated environment the live preview gives a dev server: your
  `PATH`, `HOME` and the shell basics, but no agent API keys and no GitHub token. A private
  registry token reaches it through `HSQ_ENV_PASSTHROUGH=NPM_TOKEN` (`CEZ_ENV_PASSTHROUGH` fallback) (or the tool's own config
  file under `HOME`). It also gets `HSQ_PROJECT_ROOT` (`CEZ_PROJECT_ROOT` fallback) (the main checkout, for copying untracked
  files like `.env`) and `HSQ_TASK_ID` (`CEZ_TASK_ID` fallback).
- **What you see.** The task thread shows a "Ran `<command>`" card per command with its output
  (the last 20 KB) and a line with the outcome and duration.
- **What the agent sees.** Its first message says what ran, so it doesn't repeat the install.
  If a command fails or times out, the agent still starts and its first message names the
  command, the exit code and the end of the output, so it can fix the cause or work around it.
- **Keep generated files gitignored.** Autosave commits whatever Git doesn't ignore, so anything
  setup creates outside `.gitignore` becomes part of the task's changes. `node_modules/` and
  `.venv/` are usually ignored already.

Without the key nothing runs, exactly as before. Examples:

| Project | `commands` |
| --- | --- |
| npm | `["npm ci"]` |
| pnpm | `["pnpm install --frozen-lockfile"]` |
| Python (uv) | `["uv sync --frozen"]` |
| Go | `["go mod download"]` |
| Rust | `["cargo fetch"]` |
| Copy local env | `["cp \"$CEZ_PROJECT_ROOT/.env\" .env"]` |

### Stopping a worker worktree's services before destroy

A worker's worktree can start things that keep running after the worker settles: a test
server, a file watcher, a container. Worker destroy refuses while a process still works in
the worktree, and names each one by its pid and executable name, never its arguments. Give the project a
`worktreeTeardown` and destroy runs those commands in the worker's worktree first:

```jsonc
// .ai/squawk/config.json (.ai/cezar/config.json before the project moves)
"worktreeTeardown": {
  "commands": ["command -v my-watcher >/dev/null 2>&1 && my-watcher stop . || true"],
  "timeoutSeconds": 120 // optional, per command; default 900, max 7200
}
```

The key has the shape, the limits and the environment of `worktreeSetup`. The commands run
only in a worktree whose ownership destroy has proven, before it looks for holders. A failed
command or a timeout is recorded in the worker's events, and destroy goes on: a process that
still holds the worktree is named in the refusal and never signalled, and the next retry runs
the teardown again. The key is edited in the config file only; Settings does not show it.
Without the key nothing runs, exactly as before.

### Editing the agents' own config (Settings → Agent config)

Squawk picks *which* agent runs; **Settings → Agent config** lets you edit *how* it
behaves — the raw config files Claude, Codex, OpenCode, Cursor, pi and OMP read
for settings, MCP, and memory. In the multi-project cockpit the section is project-scoped:
repo-relative files resolve from the selected project's root, while user-scope
files continue to resolve from the agent's home.

Each file keeps its native format and vendor-documented precedence. Tracked
files reach task worktrees after commit; Claude's gitignored personal layer is
seeded into each run's worktree. Config files can define hooks and MCP commands that run
on the host, so a hosted cockpit (`HSQ_REMOTE=1` or `CEZ_REMOTE=1`) is read-only and never serves home-file
contents until the host operator runs `hsq remote-settings enable`
([Remote settings administration](docs/server-install/remote-settings.md)).

---

## Local development

End-to-end, from a fresh clone to a global `hsq` command you can run in **any**
repo on your machine — no npm publish required.

**1. Prerequisites** — Node 24.21.0+ and `git` (plus at least one logged-in agent CLI,
as in [Quick start](#quick-start)).

**2. Clone & install**

The npm global prefix must be writable by your user. On Unix, use Node installed
with nvm, or set a user-owned prefix (`npm config set prefix ~/.npm-global`) and
add `~/.npm-global/bin` to your `PATH`. On Windows, use a user-owned npm prefix
and add the prefix itself (reported by `npm prefix -g`) to `PATH`; npm puts
Windows executables directly there. Set `PATH` before these commands.

```bash
git clone https://github.com/hearsay-tools/cezarion.git
cd cezarion
npm install --global pnpm@12.11.2
pnpm install --frozen-lockfile
```

Dependency installation uses pnpm 12.11.2 (pinned in `packageManager`) and
`pnpm-lock.yaml`. Use pnpm for dependency changes; keep npm for the existing
build/test scripts. Workspace dependencies are linked locally and esbuild's
install hook is approved in `pnpm-workspace.yaml`. The store uses hardlinks when
the checkout and store share a filesystem. Publishing and end-user installation
continue to use npm. For this repository's Worktrees setup, use
`pnpm install --frozen-lockfile` after the checked-out base branch contains the migration.

**3. Build** — compiles the api-client and the server (`tsc → packages/cezar/dist/`) and the cockpit
(`vite build → packages/cezar/web/dist/`), then runs the pack gate:

```bash
npm run build
```

**4. Install as a global command** — build + put `hsq` on
your PATH pointing at *this checkout*:

```bash
npm run install-as-command            # live link (default) — see the change loop below
#   or: npm run install-as-command:global   # self-contained snapshot copy

```

Now `cd` into any other repo and run it:

```bash
cd ~/some-other-project
hsq              # cockpit for that repo, straight off your checkout
hsq --help       # the same command as `npx -p @hearsay-tools/squawk hsq`
```

**5. The change loop**

- **Link mode** (default): edit source → `npm run build` → the global command
  reflects it immediately. No relink needed. (It is a live symlink into this
  checkout — don't move or delete the checkout while it's linked.)
- **Snapshot mode** (`:global`): re-run `npm run install-as-command:global` to
  refresh the installed copy. It survives moving/deleting the checkout.

**6. Uninstall**

```bash
npm run uninstall-as-command    # removes hsq and the compatibility commands (either flavor)
```

**7. Troubleshooting**

- **`hsq: command not found`** after install → your npm global bin dir isn't on
  PATH. The script prints the exact dir; add it to your shell profile
  (Unix: `export PATH="$(npm prefix -g)/bin:$PATH"`; Windows: add the directory
  reported by `npm prefix -g` itself to `PATH`, without a `bin` suffix).
- **`EACCES` / permission denied** → your global prefix is root-owned. Point npm
  at a user-writable one and retry — **never** sudo:
  `npm config set prefix ~/.npm-global`.
- **Already installed the published `@wjarka/cezarion` globally?** The
  link/snapshot install replaces it; `uninstall-as-command` removes ours, and
  `npm i -g @hearsay-tools/squawk` brings the published one back.

### In-checkout scripts

```bash
npm run dev          # server (API :4321) + Vite dev server, opens the cockpit in the browser
npm run dev:server   # tsx packages/cezar/src/index.ts — the API server alone
npm run dev:web      # Vite dev server alone (proxies /api to :4321)
npm run build        # tsc → packages/cezar/dist/, vite build → packages/cezar/web/dist/, then the pack gate
npm run typecheck    # check all four workspaces without building
npm run typecheck:web # check web sources without building
npm test             # vitest — server + cockpit unit suites
npm run test:changed # iteration only: tests related to branch + working-tree changes
pnpm metrics <file> # function complexity; add --test <test-file> for coverage and CRAP
npm run test:unit    # node:test — fast core-module tests
npm run test:package # pack/install and exercise the built CLI
npm run test:e2e     # real-browser cockpit suite (agent-browser)
npm run test:e2e:local # full browser suite in four isolated, concurrent lanes
```

The four-lane local browser run needs roughly 8 GiB of RAM at peak. It keeps CI's
serial-per-shard policy unchanged. See [cockpit E2E testing](packages/web/e2e/README.md#full-local-suite-in-four-lanes)
for lane isolation, logs, and cleanup.

Calculate metrics for one JavaScript or TypeScript file, or select a function:

```bash
pnpm metrics packages/contract/src/attention.ts
pnpm metrics packages/contract/src/attention.ts --function deriveAttention
pnpm --silent metrics packages/contract/src/attention.ts --line 150 --json
pnpm metrics packages/contract/src/attention.ts --function deriveAttention --test packages/contract/src/attention.test.ts
pnpm metrics packages/contract/src/attention.ts --coverage coverage/coverage-final.json
```

Complexity follows ESLint's classic convention, including short-circuit operators,
optional chaining, default parameters and each non-default switch case. Functions,
methods and arrow functions have separate scores. Module and class initialization
are excluded. Use `Class.method` or `--line` when a name is ambiguous.

CRAP is `C² × (1 − coverage)³ + C`, using executable line coverage within each
function body. This is the line-coverage variant; the original proposal used
basis-path coverage. An empty function uses its call counter. Missing coverage
shows `unavailable`, or `null` for CRAP in JSON. It never assumes zero coverage.
The command discovers `coverage/coverage-final.json` from the source directory
up to the checkout root, then the current directory. An explicit `--coverage`
selects an Istanbul JSON report. Reports older than the source leave CRAP unavailable;
reports must describe the current source, so regenerate them after source changes.

Repeat `--test` to collect coverage from several Vitest test files. This runs only
the supplied tests in the unit projects, with two workers and a ten-minute limit.
Coverage files are temporary and are removed after the calculation. A failed test
run exits nonzero and produces no scores. Without `--test`, no tests run. Test logs
go to stderr, so `--json` stdout contains only the report. This tool belongs to the
checkout and is available after the normal dependency installation. Use
`pnpm --silent metrics ... --json` to also suppress pnpm's command banner.

The tool is bundled in the [check-code-quality skill](.ai/skills/check-code-quality/SKILL.md).
Ask an agent to measure a file, function or module for a scoped stats report.
That path uses available coverage and reports missing CRAP without starting the
PR process. Ask explicitly for fresh coverage when needed.

The local pre-PR gate uses Squeal 0.1.423's one-shot changed-function check:

```bash
quality_report=$(mktemp "${TMPDIR:-/tmp}/code-quality.XXXXXXXX") || exit 2
squeal code --base origin/main --json > "$quality_report"
quality_status=$?
printf 'Report: %s; exit: %s\n' "$quality_report" "$quality_status"
```

It checks changed JS/TS functions, including test callbacks and nested functions,
with complexity at most 20 and CRAP at most 30. Equality passes. The default
budget is 600 seconds. The base commit supplies the policy.

A pass requires complete evidence: no skipped, incomplete or uncounted functions,
failed or unfinished tests, or exhausted budget. Exit 0 alone is insufficient
because a report can contain skipped functions. Exits 1, 3 and 2 mean violations,
incomplete measurement and usage/setup errors. Missing Squeal or unsupported
evidence blocks the PR. There is no bundled fallback or inherited-refactor
deferral. See the [pre-PR procedure](.ai/skills/check-code-quality/references/pre-pr.md)
for report identity, completeness checks and reviewable evidence.

CI and explicit statistics commands keep their existing paths during this
local-first rollout. CI artifact reuse and supported exceptions await the
remaining work in hearsay-tools/squeal#167.

For iteration, run affected test files or `npm run test:changed` (inspect with
`-- --plan`; override the local main comparison with `-- --base=<ref>`).
The changed-test command includes staged, unstaged and untracked changes and
falls back to full Vitest on shared/configuration/unknown input or missing Git
history. It is not a substitute for final verification. See [AGENTS.md § Validation](AGENTS.md#validation)
for targeted browser commands and the [CI guide](docs/sdlc/ci.md) for the final-gate/evidence-reuse policy.

`npm run typecheck` checks all four workspaces from source without writing build
output. `npm run typecheck:web` checks the cockpit and reads the server route types
from this checkout. Run `pnpm install --frozen-lockfile` in each new worktree first.
Packaged CLI tests import built modules; CI checks them with
`npm run typecheck:package` after `npm run build`.

CI runs eight duration-balanced Vitest shards alongside the build and package checks.
See [CI verification](docs/sdlc/ci.md) for the job graph and local commands.

The stack is deliberately small: **TypeScript** (strict, ESM), **Hono** + SSE for
the server, **Zod** at every boundary, **YAML** for workflows, and a **React 19 +
Vite + Tailwind v4 + shadcn/ui** cockpit shipped pre-built in `packages/cezar/web/dist/` — the
published package carries the built app, so `npx` users never run a bundler.
Every module is meant to be read in one sitting.

---

## License

**MIT** © Patryk Lewczuk (original Cezar) and Wiktor Jarka (Cezarion) — full text in [LICENSE](LICENSE).
