# Core layer map (hearsay-tools/squawk#3706)
Status: active

Step 0 of [the plan](2026-11-18-plugin-core-roadmap.md) that makes Squawk a small core with
features built as plugins. This step writes the line down and stops new leaks. It moves no code.
The rule and its three binding rules are in
[ADR 0065](../../docs/adr/0065-define-the-core-by-a-layer-map.md). This spec keeps the layers,
the owner's layer calls and the measurement.

## Goal

Every non-test source file under `packages/cezar/src` has one layer. A new import from a `core`
file into a feature or runner file fails `npm run lint`. The imports that exist today are listed,
each with a reason, and the list only shrinks.

## Product decisions (owner, 2026-11-16)

1. **`delegation/` (workers and messages) → `feature:workers`.** The rule stops new ties. No
   removal is planned: it is the deepest feature. `worker-scope/` (per-worker process ownership,
   hearsay-tools/squawk#2180) joins `feature:workers`.
2. **Wait kinds.** The wait engine (`workflows/run/wait-engine.ts`) is core. `human`, `timer` and
   `process` ship with the core. `pr` belongs to `feature:forge`, `worker` and `peer` to
   `feature:workers`, and `subagent` to the runners. Today the engine imports
   `ci-wait/supervisor.ts`; the baseline lists that import. The engine also branches on the
   `worker` watch; the rule reads imports only, so that branch is recorded here, not in the
   baseline, and the step that moves the `worker` kind removes it.
3. **Agent tools.** `cezar_ask`, `cezar_done` and `cezar_wait` are core. The preview tools and the
   schedule tools belong to their features.
4. **Type-only imports count.** A type still ties two layers, and the fix (move the type to
   core) is cheap.

## Layers

`packages/cezar/src/lint/layers.json` is the source of truth; this table describes it. A path is
relative to `packages/cezar/src`. The longest matching path wins.

| Layer | Paths |
| --- | --- |
| `core` | `core/` (except the runner files and the accounts file), `runs/` (except `runs/webhook.ts`), `workflows/`, `home/` and `workspace/` (except the accounts files below), `process-wait/`, `ci-wait/` (except the forge files below), and the root files `config.ts`, `data-gitignore.ts`, `detached-process.ts`, `git-*.ts`, `handoff.ts`, `legacy-runs.ts`, `merged-streams.ts`, `paths.ts`, `project-fence.ts`, `project-paths.ts`, `session-context.ts`, `task-branch-head.ts`, `ui-state.ts`, `worktree-manifest.ts`, `worktree-setup.ts` |
| `runner` | `core/claude-*`, `core/codex-*`, `core/cursor-*`, `core/omp-*`, `core/opencode-*`, `core/pi-*` |
| `shell` | `server/` (except `server/forge/`), `cez.ts`, `cezarion.ts`, `cli-dispatch.ts`, `headless-run.ts`, `hsq.ts`, `index.ts`, `project-commands.ts`, `serve-*.ts`, `server-command.ts`, `subcommands.ts`, `use-command-notice.ts` |
| `tooling` | `lint/` |
| `feature:workers` | `delegation/`, `worker-scope/` |
| `feature:accounts` | `core/agent-profiles.ts`, `workspace/agent-accounts.ts`, `workspace/agent-profiles.ts`, and in `home/` the account migration: `legacy-account-paths.ts`, `migration-account-source.ts`, `migration-accounts.ts` |
| `feature:forge` | `server/forge/`, and in `ci-wait/` the PR watcher: `github.ts`, `supervisor.ts`, `progress.ts`, `merge-progress.ts`, `resources.ts`, `resource-pool.ts` |
| `feature:skills` | Root `skills*.ts` |
| `feature:autosave` | Root `autosave-*.ts` |
| `feature:webhooks` | `webhooks/`, `runs/webhook.ts` |
| `feature:server-install` | `server-install/`, `managed-install/` |
| `feature:migration` | `project-migration/` |
| Other features, one directory each | `activity/`, `agent-config/`, `artifacts/`, `automations/`, `discovery/`, `jobs/`, `preview/`, `release/`, `task-cli/` |
| Other features, one root file each | `archive-on-merge-setting.ts`, `desktop-supervisor.ts`, `install-as-command.ts`, `merge-observations.ts`, `open-url.ts`, `pack-check.ts`, `planner.ts`, `remote-settings.ts` with `remote-settings-cli.ts`, `update-check.ts` |

`ci-wait/` holds both the agent tools (core, decision 3) and the PR watcher (forge), so the map
splits it by file. The tool files (`tools.ts`, `tool-catalog.ts`, `mcp.ts`, `client.ts`,
`controller.ts`, `injection.ts`, `errors.ts`, `text.ts`) are core.

Agent accounts became `feature:accounts` on 2026-11-18 (hearsay-tools/squawk#3865): the core can
run every task on the discovered login. The usage-limit key (`workflows/execution-account.ts`)
and the per-account login cache (`core/provider-auth.ts`) stay core: they take the account as a
plain label. The 11 imports this added to the baseline go when the core gains a
launch-environment slot.

## Evidence

Measured on `main` at `7d49c0e5c` with the map above and the rule's own scanner:

| Layer | Files |
| --- | --- |
| `core` | 283 |
| `runner` | 45 |
| `shell` | 68 |
| `tooling` | 34 |
| Features | 188, in 25 features |

| Imports from `core` into | Imports |
| --- | --- |
| `feature:workers` | 72 |
| `feature:skills` | 13 |
| `feature:forge` | 11 |
| `feature:preview` | 9 |
| `feature:autosave` | 6 |
| 7 other features | 20 |
| `runner`, outside `core/runner-factory.ts` | 15 |
| **All** | **146**, from 70 files, in 145 baseline entries |

The issue's draft measurement found 127 core-to-feature imports and 21 core-to-runner imports.
The rule finds more feature imports because it also reads side-effect imports, `import()` types
and `import … = require()`. It finds fewer runner imports because it excludes the runner factory
and splits `ci-wait/` by file.

## Plan

This step:

- `packages/cezar/src/lint/layers.json`: the map.
- `packages/cezar/src/lint/layer-import.ts`: `cez/layer-import` (oxlint, per file) and the
  repository checks in `npm run lint` (a file with no layer, a map path that matches no file, a
  repeated path, a tie between two paths, a stale baseline entry).
- `packages/cezar/src/lint/layer-import.baseline.json`: the 145 entries, each with a reason that
  starts with the imported layer.
- [`docs/sdlc/lint.md`](../../docs/sdlc/lint.md): the rule, its static scope, and how to update
  the map and the baseline.

Later steps, each its own issue, are in the
[plugin core roadmap](2026-11-18-plugin-core-roadmap.md): a plugin API and loader (steps 1 to
4), then moving features behind it, which shrinks the baseline. Rules between two features,
rules for `shell` files, and layers for `packages/web`, `packages/contract` and
`packages/api-client` are follow-ups.
