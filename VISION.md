# Product vision

## Purpose

Squawk (`hsq`) is a local, zero-config orchestrator and browser cockpit for running parallel AI coding agents in isolated git worktrees.

It solves the gap between opaque single-terminal CLI runs and hosted cloud coding products:
- Agents run under the user's own CLI logins (`claude`, `codex`, `opencode`, `pi`, `omp`, `antigravity`, or a mix per workflow step), `gh` auth, and local files — with no Squawk account, no cloud backend, and no external database server.
- Tasks queue, run in parallel in isolated worktrees, stream live events, and leave reviewable diffs on branches.
- Leaving Squawk on a VPS or dedicated box turns it into an always-on coding host driven from a laptop or phone.

Architecturally, Squawk is evolving toward a small core with features built as plugins (the shape of `pi`, tracked in [.ai/specs/2026-11-18-plugin-core-roadmap.md](.ai/specs/2026-11-18-plugin-core-roadmap.md)): a compact run engine, open registries, and a typed lifecycle — while remaining an orchestrator over external agent CLIs rather than becoming an agent itself.

The roadmap also plans remote execution: tasks that run on other machines the user controls, driven from one place.

## Users

- **Solo developers and small teams:** Run several coding agents in parallel under existing CLI subscriptions without sending code or API keys to a third-party SaaS.
- **VPS / always-on host operators:** Keep Squawk running on a server to drain backlogs, monitor live work, steer sessions, manage accounts and settings remotely (when granted on the host), and review diffs from a laptop or phone.
- **Teams with shared workflows:** Orchestrate multiple repositories in one cockpit using portable YAML workflows and each runner's native skills and conventions.
- **Runner and plugin authors:** Add runners, agent tools, wait kinds, workflow step kinds, CLI commands, and features through the plugin API (`@hearsay-tools/squawk/plugin`) without forking the core. Today this is the Squawk team and host operators using `<config>/plugins/`; wider distribution waits for package installation and a trust model.

## Principles

1. **Zero config and graceful degradation.** Ship no required config file, wizard, API key, or external database. Discover what exists or provide a working default. A missing CLI, absent `gh`, read-only home, or broken host plugin degrades to a smaller working cockpit instead of failing boot. Never trade a working default for a knob.
2. **Small core, open seams, one API.** Keep `core` limited to what every task needs ([packages/cezar/src/lint/layers.json](packages/cezar/src/lint/layers.json), [ADR 0065](docs/adr/0065-define-the-core-by-a-layer-map.md)). Built-in features use the same plugin API as external plugins — no private core hooks, and no plugin API designed before a first-party feature moves onto it.
3. **Orchestrate native CLIs; do not duplicate them.** Delegate model loops and skill discovery, storage, and expansion to each runner's native CLI and account home ([ADR 0066](docs/adr/0066-use-runner-native-skills.md)). Keep accounts in core so any runner plugin works with account switching and usage-limit holds without a competing plugin.
4. **Human control over landing and trust.** Isolate each task in its own git worktree and branch. Keep auto-merge off by default; require explicit opt-in plus current-head CI and GitHub rules before merging. Keep host-folder plugins under host-operator filesystem trust ([ADR 0070](docs/adr/0070-load-host-folder-plugins-and-export-the-runner-kit.md)); never let a remote cockpit session install or toggle plugins.
5. **Protect saved state; evolve interfaces freely.** Upgrades must keep opening or migrating saved runs, transcripts, and home configuration. Commands, flags, routes, environment variables, URLs, and pre-package-install plugin APIs may change or be removed without aliases or deprecation windows. The plugin API stability promise starts only when Squawk installs plugin packages from npm or git.
6. **Incremental, measured change over rewrites.** Open existing seams one slice at a time, shrink explicit baselines, keep `main` usable at shipped defaults after every slice, and enforce architectural rules with types and lint rather than prose.

## Out of scope

- **An in-house LLM or model loop.** Squawk orchestrates external agent CLIs; it does not implement its own model loop or compete with the runners it drives.
- **A hosted SaaS, cloud user accounts, or an external database server.** State stays local in embedded SQLite (`runs.db`), append-only NDJSON logs, and Markdown journals. Planned remote execution uses machines the user controls and adds no Squawk service.
- **A Squawk-owned skill catalog or worktree skill installer.** Runners own their own skills ([ADR 0066](docs/adr/0066-use-runner-native-skills.md)).
- **Pluggable run storage.** The run store stays one SQLite store behind typed ports, not a plugin seam.
- **Big-bang rewrites or speculative plugin APIs.** No rewrite from scratch, and no extension hook added before a first-party feature uses it.
- **Untrusted React code inside the cockpit bundle.** Future cockpit plugin UI uses server-described data slots or sandboxed frames, never external React components loaded into the SPA bundle.
- **Project-scoped plugins, remote UI plugin installation, or npm/git plugin installs (until a trust gate is designed).** Today only the host operator adds plugins under `<config>/plugins/`.
- **Unconditional auto-merge.** Merging stays opt-in and gated on passing checks and repository rules.
