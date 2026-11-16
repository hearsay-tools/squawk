# Configuration (optional)

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
[project registry](areas/workspace-registry.md#multiple-projects-one-cockpit), and are edited from
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
logs which blocks it applied or skipped. See [docs/context-injection.md](context-injection.md)
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
operator runs `hsq remote-settings enable` ([Remote settings administration](server-install/remote-settings.md)).

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
only in a worktree whose ownership destroy has proven, before destroy stops the worker's
process scope. A failed command or a timeout is recorded in the worker's events, and destroy
goes on: stopping the scope ends what the worker started (on macOS, and on Linux without
cgroup delegation, a process that left the worker's process groups can survive; see
[ADR 0032](adr/0032-prove-process-and-workspace-ownership-before-cleanup.md)). A process that
is not the worker's is never signalled and does not block the removal. The key is edited in
the config file only; Settings does not show it. Without the key nothing runs, exactly as before.

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
([Remote settings administration](server-install/remote-settings.md)).

---

Useful environment variables:

| Var | Effect |
|---|---|
| `HSQ_*` settings (`CEZ_*` fallback) | Ordinary settings prefer a defined HSQ value, including empty. Home, hosted-mode REMOTE and native shell controls use the separate rules below. Both home locators and inherited controller authority are removed from child environments, even in full-env mode. |
| `CEZ_DELEGATION` | Retired (hearsay-tools/cezarion#2784); has no effect. Workers and task messaging are per-task settings, both on by default. See [Owned workers](workers.md#owned-workers). |
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
| `HSQ_HOME=/path/to/home` (`CEZ_HOME` fallback) | Selects `config/`, `state/`, `data/`, `cache/`, and `run/` below this directory. With neither set, uses the [platform roots](migration.md#home-directories). A non-default `CEZ_HOME` keeps its permanent one-root fallback; an explicit legacy-default `CEZ_HOME` uses the platform roots. Both home locators are removed from child environments. |
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
