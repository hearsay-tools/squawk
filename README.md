<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/web/public/cezarion-mark-dark.svg">
  <img src="packages/web/public/cezarion-mark-light.svg" alt="" width="96" height="96">
</picture>

# Squawk

**Parallel coding agents orchestrator** — a local cockpit for running and
tracking AI coding-agent tasks in your repo.

Type a task, pick a workflow and an agent — **Claude Code, Codex, OpenCode, pi,
OMP or Antigravity (OpenCode, pi and OMP experimental), or a mix of them per step** — and watch it work live: steps, tool calls,
tokens, diffs, in a browser cockpit that runs entirely on your machine.
Your CLI logins, your `gh`, your files. No accounts, no database server, no cloud.

🔥 **Fire and forget.** Queue a stack of autonomous coding and maintenance
tasks and let them run — Squawk orchestrates them across isolated worktrees,
in parallel. Flip the **Autonomous** flag
and a run never stops to ask; it just finishes. Leave it on a VPS and you get
a dev team that's *always on* — a mobile-friendly cockpit you can check from
your phone, working your backlog while you're away.

[A look inside](#a-look-inside) · [What Squawk does best](#what-squawk-does-best-) · [What it solves](#what-it-solves) · [Who it's for](#who-its-for) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Core concepts](#core-concepts) · [Cockpit tour](#cockpit-tour) · [Agent backends](docs/areas/runners.md#coding-agent-backends) · [Remote access](docs/remote-access.md#remote-access-host-squawk-on-a-server)

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
moving a server or custom-home install. User paths such as `<config>`
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
  `claude` / `codex` / `opencode` / `pi` / `omp` logins and the `gh` you already have, and every
  missing piece degrades gracefully instead of blocking you. The Google Antigravity CLI
  installs and signs in from **Settings → Agents**.
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
  (`HSQ_REVIEW_GATE=1` (`CEZ_REVIEW_GATE` fallback) or Settings → Agent defaults) and a finished run with changes
  waits in `review` for you.
- ♻️ **Losing a session when it fails.** Every run records its `claude` session id.
  Take it over interactively in one click (`claude --resume <id>`), or continue it
  in-process from the cockpit. After a failure, Continue tells the agent which
  step failed and gives its saved error before your message. Restart recovery
  also explains the restart when replaying a saved message. The agent is told that
  subagents from the stopped process stopped with it and that its shell commands
  may have stopped. The cockpit shows this notice beside your message.
- 🔀 **Locked into one agent vendor.** Most tools wed you to a single CLI. Squawk
  drives **Claude Code, Codex, OpenCode, pi, OMP and Antigravity** (OpenCode, pi and OMP
  experimental) through one runner seam — set a
  default, pick a backend per task, or mix them inside one workflow (implement
  with one agent, review with another) — and through **OpenCode**, **pi** or
  **OMP** you can point a run at **open-source or local models**, not just the
  big vendors. See
  [Agent backends](docs/areas/runners.md#coding-agent-backends).
- 🖥️ **Close the laptop and the work stops.** A local agent only runs while your
  machine is on and awake. Put Squawk on a **VPS, cloud box, or dedicated server**
  and the cockpit becomes the GUI for an **always-on AI coding team** — kick off,
  watch and steer tasks from your laptop or **phone**, on the train or between
  meetings, while the agents keep grinding through the backlog back on the server.
- ⚡ **Setup tax.** No wizard, no env vars, no schema. Skills are Markdown, workflows
  are short YAML, and everything degrades: no `gh` → works without PRs, no network
  → installed local skills still load, no selected skill → the plain prompt still runs.

---

## Who it's for

- **Solo devs and small teams** who want the leverage of coding agents without
  handing their code and keys to a SaaS — the agent runs on your subscription,
  on your machine.
- **`claude` CLI power users** who love headless runs but want to *see* them,
  and review a diff before it lands.
- **Anyone with a backlog** who'd rather queue three tasks into isolated worktrees
  and pick the winners than babysit one terminal.
- **Teams with shared conventions** who share playbooks through their runner’s
  project configuration or tracked native skill folders.

---

## Quick start

**Prerequisites:** Node 24.21.0+, at least one logged-in agent CLI — the
[`claude` CLI](https://github.com/anthropics/claude-code) (Pro/Max subscription),
the [`codex` CLI](https://github.com/openai/codex),
[OpenCode](https://opencode.ai), the
[pi](https://github.com/badlogic/pi-mono), or
[OMP](https://github.com/can1357/oh-my-pi) — and, optionally, `git` and the
`gh` CLI. You can also install the Google Antigravity CLI from **Settings → Agents**
once the cockpit runs. Sign in there with a Google account, or set `GEMINI_API_KEY`.

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

> **Contributing?** [Local development](docs/development.md#local-development) shows how to get a
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
(Claude Code by default; Codex, OpenCode, pi, OMP and Antigravity are drop-in
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
   └──────────────────────────────┘     │  pi · omp · antigravity        │
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
- 📖 **Skills** are playbooks your selected runner already has. Squawk lists that
  runner's skills for the selected account and starts a pick through its native
  trigger. Use the runner's own tools or tracked native skill folders to share
  playbooks. The **Skills** page shows a read-only inventory with metadata,
  paths when reported, problems and a Re-read button. A workflow step selects a
  runner skill id with `skill: <id>`; a missing or ambiguous selection fails
  before a model call. See [Skills](docs/areas/skills.md).
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
  Settings → Agent defaults): with it on, a successful run with changes parks in `review`
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
| **Skills** | Read-only skills reported by one runner and account, with native metadata, paths, problems and Re-read. |
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

See [How it runs agents](docs/areas/runners.md).

## Coding agent backends

See [Coding agent backends](docs/areas/runners.md).

## Remote access (host Squawk on a server)

See [Remote access (host Squawk on a server)](docs/remote-access.md).

## Reviewing task files

See [Reviewing task files](docs/task-files.md).

## Configuration (optional)

See [Configuration (optional)](docs/configuration.md).

## Local development

See [Local development](docs/development.md).

## License

**MIT** © Patryk Lewczuk (original Cezar) and Wiktor Jarka (Cezarion) — full text in [LICENSE](LICENSE).
