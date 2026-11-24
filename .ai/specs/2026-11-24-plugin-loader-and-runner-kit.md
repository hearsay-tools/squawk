# Plugin loader and runner kit
Status: active

Step 4 (first version) of [the plugin core roadmap](2026-11-18-plugin-core-roadmap.md), epic
hearsay-tools/squawk#4188. Baseline: `main` at `a7b4165bf`. The owner settled all seven design,
trust, live-runner, and execution decisions on 2026-11-24 (task `e0b9b34a`). The work lands in
15 slices, one child issue each; see [the plan](2026-11-24-plugin-loader-and-runner-kit-plan.md).

## Goal

Load plugin packages from one host folder (`<config>/plugins/`) with zero configuration, unify
process boot behind one register-load-seal boundary, export a complete runner kit so built-in and
outside runners import only one public package entry, and keep stored runner settings intact when
a runner plugin fails to load. After this step:

- one boot module (`packages/cezar/src/boot.ts`) registers every built-in, loads plugins, and
  seals every registry; no other production file seals a registry;
- a plugin is a folder whose `index.mjs` or `index.js` entry exports a default setup function
  receiving `SquawkPluginApi` (the seven register calls plus run-lifecycle subscription);
- the loader discovers plugins in `<config>/plugins/` in sorted folder-name order with no
  configuration setting, installs an in-process `node:module` `registerHooks` resolve hook mapping
  `@hearsay-tools/squawk/plugin` to the running install, and stages each plugin's registrations
  transactionally so a throwing or key-colliding plugin rolls back cleanly, is skipped, is logged
  by `hsq`, and is reported by `GET /api/v1/health`;
- `@hearsay-tools/squawk/plugin` exports the plugin API types and the complete runner kit; every
  built-in runner imports only from its own folder, Node/npm dependencies, and
  `@hearsay-tools/squawk/plugin`, enforced by shrink-only lint rule `cez/runner-core-import` at 0
  baseline entries;
- built-in runners load through the exact same plugin loader and `SquawkPluginApi` as host-folder
  plugins, removing `runners/built-in.ts` and `runners/ids.ts`;
- stored workspace and repo settings (`agentDefaults.runner`, `disabledProviders`,
  `agent-accounts.json` rows/selections, repo `defaultRunner`/`defaultModels`) survive a start
  where their runner plugin did not load;
- `managed-install/` moves to its own `feature:runner-install` layer with a per-runner manifest
  parser hook (hearsay-tools/squawk#4100);
- an automated test loads a plain-JS fixture runner package from outside the repository and runs
  a task to the review gate, and the real `pi` runner loaded from `<config>/plugins/` completes a
  task on its real CLI in a live acceptance run.

## Out of scope

- Project-scoped plugins and a project trust decision gate: a later epic. Registries are
  process-wide and one cockpit serves many projects.
- Installing plugins from npm or git, install/uninstall commands, and cockpit plugin management:
  a later epic.
- Workflows shipped inside a plugin package: add when a first-party package needs them.
- New extension slots (launch slots, HTTP routes, WebSocket topics): roadmap step 5.
- Cockpit UI slots: roadmap step 6.
- Accounts as a plugin: closed as not planned (agent accounts are core).

## Done when

- **Outcome:** all 15 child issues (hearsay-tools/squawk#4198 through hearsay-tools/squawk#4211
  plus hearsay-tools/squawk#4100) are closed on `main`, this spec is `Status: done`, its
  `-plan.md` is deleted, the roadmap marks step 4 Done, ADR 0070 records the loader, API object,
  and runner kit, and ADR 0065 rule 3 is amended.
- **Proof:** `npm run prepr` and CI pass; a guard test confirms only `boot.ts` seals registries
  in production; `runner-core-import.baseline.json` holds 0 entries; `index-runners.test.ts`,
  `index-run-slots.test.ts`, and `core/runner-closure.test.ts` pass; an automated test runs a task
  on an external plain-JS runner package importing only `@hearsay-tools/squawk/plugin`; a live
  acceptance run completes a task on the real `pi` CLI loaded from `<config>/plugins/`.
- **Failure:** a plugin that throws during setup or collides on any registry key rolls back every
  registration it staged, is skipped so the cockpit still boots, logs its name and error on `hsq`
  stderr, and appears under `plugins.failed` in `GET /api/v1/health`; cold CLI commands refuse to
  load plugins, runners, or stores; HTTP write routes continue to reject unregistered runner ids.

## Evidence

Measured on `main` at `a7b4165bf` (2026-11-24). `layer-import.baseline.json` holds 93 entries.

### Current seal sites in production

| File | What it seals today |
| --- | --- |
| `packages/cezar/src/index.ts` | `sealBuiltInCliCommands()` at import |
| `packages/cezar/src/home/entry.ts` | `sealBuiltInCliCommands()` inside `prepareHomeLifecycle()` |
| `packages/cezar/src/subcommands.ts` | Five sequential register-then-seal pairs inside `prepareCommandRuntime()` |

### Runner outside imports (`packages/cezar/src/runners/<id>/`, non-test `.ts`)

| Runner | Files | Outside targets (static) | Value targets | Dynamic outside imports |
| --- | ---: | ---: | ---: | --- |
| `antigravity` | 37 | 32 | 29 | none (sole consumer of `runners/acp/*`) |
| `claude` | 22 | 23 | 18 | `agent-config/model-settings/claude.ts` |
| `codex` | 28 | 30 | 24 | `agent-config/model-settings/codex.ts` |
| `omp` | 20 | 30 | 21 | none (imports `runners/pi/pi-rpc-wire.ts`, `pi-rpc-turn.ts`) |
| `opencode` | 27 | 30 | 25 | `agent-config/model-settings/opencode.ts` |
| `pi` | 21 | 30 | 20 | `agent-config/model-settings/pi.ts` |

Stateful core modules imported by runners (proving why a second package copy causes split state):
- `core/session-process.ts`: module-level `leaders` `Map` and `spawned` `WeakSet`.
- `ci-wait/tool-names.ts`: reads the sealed process-wide agent tool registry.
- `managed-install/runtime-home.ts`: module-level `bound` `Home` reference.

Cross-runner and shared `runners/` files:
- `runners/pi/pi-rpc-wire.ts` (imported by `pi`, `omp`, `codex`) and `runners/pi/pi-rpc-turn.ts`
  (imported by `pi`, `omp`).
- `runners/login-output.ts`, `runners/mock-prompts.ts`, `runners/project-agents-file.ts`,
  `runners/agent-config-notes.ts`.
- `runners/acp/` (5 files, imported only by `antigravity`).

### Stored-config decoders that drop unknown runner ids today

- `packages/cezar/src/workspace/config.ts`: `agentDefaults.runner`
  (`registeredRunnerIdSchema().optional().catch(undefined)`) and `disabledProviders` (filters to
  `knownRunnerIds()`). `registeredRunnerRecord` already preserves unknown keys.
- `packages/cezar/src/workspace/agent-accounts.ts`: `agentAccountSchema.provider`
  (`registeredRunnerIdSchema().refine(supportsProfiles)` drops rows whose runner did not register).
- `packages/cezar/src/config.ts`: `defaultRunner` and `defaultModels` (drops unregistered keys).

### Squeal baseline selection counts (Roadmap rule 5, revision 0 at `a7b4165bf`)

| File | Selected test files | Notes |
| --- | ---: | --- |
| `packages/cezar/src/core/registry.ts` | 1,152 | 1,054 current pass, 98 manual browser unknown |
| `packages/cezar/src/core/runner-registry.ts` | 1,266 | 1,168 current pass, 98 manual browser unknown |

## Owner decisions (2026-11-24)

1. **API stability promise (ADR 0065 rule 3).** Defer the stability promise until Squawk installs
   packages from npm or git. Amend ADR 0065 rule 3 accordingly and document the plugin API and
   runner kit as unstable (able to change in any release) during this host-folder version.
2. **In-process execution and host trust.** Plugins placed in `<config>/plugins/` by the host
   owner run in-process inside Squawk with all of Squawk's permissions and logins. Document this
   trust boundary explicitly. Provide no cockpit UI or API to install or remove plugins (local or
   `HSQ_REMOTE=1`). Project-level plugins and trust gates stay in a later epic.
3. **Kit resolution and entry format.** The loader installs an in-process `node:module`
   `registerHooks` resolve hook before loading plugins, mapping `@hearsay-tools/squawk/plugin`
   (one public entry exporting both plugin API types and the runner kit) to the running Squawk
   copy. Every stateful registry write and run-lifecycle subscription goes through the `api` object
   passed to the plugin's default-exported setup function. Entry file format: plain JavaScript
   (`index.js` or `index.mjs`) in this version.
4. **Plugin CLI commands and cold startup (`hsq --help`).** Plugins may register CLI commands.
   Cold built-in commands (`--help`, `--version`, `job`, `artifact`, `message`, `webhook`,
   `automation`, `backup --help`, `remote-settings --help`, `worker list|inspect|collect|wait`)
   stay cold with zero plugin loading. When `hsq` receives an unknown command name, it runs full
   boot (loading plugins) before failing with `unknown command`, so `hsq <plugin-cmd>` works.
   `hsq --help` stays cold and lists built-in commands only, with a short footer note pointing to
   runtime plugin listing (`hsq plugins`).
5. **Load order, registration conflicts, and failure reporting.** Built-ins load first, then
   `<config>/plugins/*` in sorted folder-name order. Each plugin's registrations stage
   transactionally and commit only if setup finishes with no throw and no key conflict. On throw
   or conflict, zero partial registrations leak, the plugin is skipped so the cockpit still boots
   (`AGENTS.md` § Zero config), `hsq` logs a warning to stderr naming the plugin and error, and
   `GET /api/v1/health` exposes `plugins: { loaded, failed }` (omitting host filesystem paths when
   `HSQ_REMOTE=1`).
6. **First real runner for the live `<config>/plugins/` acceptance run.** `pi` (21 files,
   installed on the host, independent of hearsay-tools/squawk#4100).
7. **Execution scope and merge authority.** Task `e0b9b34a` lands this spec PR, files all child
   issues, and coordinates all slices through integrated acceptance on `main` using Squawk
   workers. The coordinator may squash-merge approved slice PRs once CI, pre-PR review, and all
   review threads are clean; paths on the auto-merge never-list (`AGENTS.md`, gate/harness files)
   wait for owner approval.

## Design

### 1. Unified boot boundary (`packages/cezar/src/boot.ts`)

`packages/cezar/src/boot.ts` is the sole production module allowed to seal registries:

- `bootColdCli()`: registers built-in CLI commands and seals `cli-registry` only. Used by cold
  commands (`--help`, `--version`, and built-in commands whose `runtimeMode` evaluates to false).
  Loads zero runner, store, or plugin modules.
- `bootRuntime(options?)`: registers all built-ins (CLI commands, runners, removal slots, worker
  executions, workflow step kinds, agent tools, wait kinds), runs bundled and host-folder plugins
  through the loader, and seals all seven registries plus `runs/lifecycle-registry.ts`.
  Idempotent once full boot has run.
- `cli-dispatch.ts` / `subcommands.ts` / `index.ts`:
  - Check built-in CLI commands passively (or register built-in CLI commands unsealed first).
  - If `--help`, `--version`, or a built-in command with `runtimeMode === false` is invoked, call
    `bootColdCli()` and dispatch without loading plugins.
  - If a built-in runtime command OR an unknown command name is invoked, call `bootRuntime()`
    (which loads plugins so any plugin CLI command registers into `cli-registry` before seal), then
    dispatch normally.
  - `home/entry.ts` (`prepareHomeLifecycle`) stops sealing `cli-registry` directly and delegates
    to `bootColdCli()` (or `bootRuntime()` when not already booted).
- A unit test scans non-test `.ts` files under `packages/cezar/src/` (excluding the registry
  definition modules and `boot.ts`) and fails if any other production file calls a `seal*()`
  function.

### 2. Plugin API object, transactional staging, and run-lifecycle registry

- **Process-wide run-lifecycle registry (`packages/cezar/src/runs/lifecycle-registry.ts`):**
  `createListRegistry<RunLifecycleHandlers>` using `core/registry.ts`. Sealed by `boot.ts`. When
  `RunStore` opens (when the registry is sealed), it subscribes every registered listener to its
  `store.lifecycle` and unsubscribes them when `store.closed` fires. Tests that do not boot the
  full runtime keep passive behavior (`isSealed()` check) so isolated store tests stay untouched.
- **Plugin contract (`packages/cezar/src/plugin/api.ts`):**
  - A plugin module exports `default function setup(api: SquawkPluginApi): void | Promise<void>`.
  - `SquawkPluginApi` exposes:
    - `registerRunner(definition: RunnerDefinition): void`
    - `registerAgentTool(tool: AgentToolDefinition): void`
    - `registerWaitKind(row: WaitKindRow): void`
    - `registerStepKind(step: StepKindDefinition): void`
    - `registerCliCommand(command: CliCommandDefinition): void`
    - `registerRemovalSlots(slots: Partial<RunSlots>): void`
    - `onRunLifecycle(handlers: RunLifecycleHandlers): void`
- **Transactional staging (`runPluginSetup`):**
  - Before invoking `setup(api)`, create a staged buffer capturing all calls made on `api`.
  - Validate each staged key against both the live unsealed registries (existing keys + reserved
    legacy keys via `peekHas` / reserved check) and duplicates within the same plugin's buffer.
  - Only after `await setup(api)` completes cleanly AND every staged registration passes conflict
    validation do all staged entries commit into the real registries.
  - If `setup(api)` throws or any staged entry conflicts, nothing commits and the error is returned
    to the loader so the plugin is skipped cleanly.
- **Public package entry (`packages/cezar/src/plugin/index.ts`):**
  - Exported as `"./plugin"` in `packages/cezar/package.json` (`./dist/plugin/index.js` + types).
  - Re-exports `SquawkPlugin`, `SquawkPluginApi`, registration types, and the runner kit.
  - Monorepo dev/test resolution maps `@hearsay-tools/squawk/plugin` to
    `packages/cezar/src/plugin/index.ts` in `tsconfig` / `vitest` and at runtime via `registerHooks`.

### 3. Runner kit and shrink-only import boundary

- **Shared helper extraction (B1):**
  - Move `runners/login-output.ts`, `runners/mock-prompts.ts`, `runners/project-agents-file.ts`,
    `runners/agent-config-notes.ts`, and the shared Pi-RPC helpers from `runners/pi/pi-rpc-wire.ts`
    and `runners/pi/pi-rpc-turn.ts` into leaf modules under `core/` (or `plugin/`), so no runner
    imports from another runner's folder.
  - Keep `packages/cezar/src/plugin/runner-kit.ts` stateless, re-exporting leaf core helpers,
    `agent-config/model-settings/shared.ts`, and `feature:runner-install` hooks (from
    hearsay-tools/squawk#4100).
- **Per-runner isolation (B2–B7):**
  - Move `agent-config/model-settings/{claude,codex,opencode,pi}.ts` into each owning
    `runners/<id>/` folder.
  - Move `runners/acp/` into `runners/antigravity/acp/` (its sole consumer).
  - Rewrite every outside relative import in non-test files under `runners/<id>/` to import from
    `@hearsay-tools/squawk/plugin`.
- **Lint gate (`cez/runner-core-import`):**
  - AST rule in `packages/cezar/src/lint/runner-core-import.ts` inspecting every non-test `.ts`
    file under `packages/cezar/src/runners/<id>/` (excluding `runners/fixture/`).
  - Flags any static `import`/`export ... from` or dynamic `import(...)` whose relative specifier
    resolves outside `packages/cezar/src/runners/<id>/`.
  - Backed by shrink-only `packages/cezar/src/lint/runner-core-import.baseline.json` (checked by
    `.github/scripts/baseline-growth.cjs`). Starts with all current outside imports in B1 and
    drains to `[]` after B2–B7.

### 4. Host-folder plugin loader, resolve hook, failure reporting, and CLI commands

- **Home path:** `Home` (`packages/cezar/src/home/home.ts`) adds `readonly plugins: string` set to
  `join(config, 'plugins')`.
- **Resolve hook (`packages/cezar/src/plugin/resolve-hook.ts`):**
  - Installs once via `registerHooks` from `node:module` before loading any plugin.
  - Intercepts `'@hearsay-tools/squawk/plugin'` (and its package subpath if referenced) and
    resolves it to the running Squawk copy's file URL (`new URL('./index.ts', import.meta.url)`
    under source/tsx/vitest, `new URL('./index.js', import.meta.url)` under built `dist/`).
- **Discovery and order (`packages/cezar/src/plugin/loader.ts`):**
  - Reads `<config>/plugins/` (if present). Missing directory is a silent no-op (zero config).
  - Iterates direct child directories (and symlinks to directories) in deterministic lexicographic
    order (`localeCompare` / ASCII code-point sort on folder name).
  - Entry file lookup inside each plugin folder: `index.mjs` first, then `index.js` (and `index.ts`
    only for bundled source folders under tsx/vitest). Folders without an entry file are skipped
    and recorded as failed with a clear message (`missing index.mjs or index.js`).
  - Records a process-wide immutable `PluginLoadReport` (`{ loaded: LoadedPlugin[], failed: FailedPlugin[] }`).
  - For every failed plugin, logs one concise stderr warning (`[hsq] plugin "<name>" skipped: <reason>`).
- **Health and CLI reporting:**
  - `GET /api/v1/health` (`packages/contract/src/health.ts` + `packages/cezar/src/server/server.ts`)
    adds optional `plugins: { loaded: PluginHealthEntry[], failed: FailedPluginHealthEntry[] }`.
    Each entry carries `name` and `source` (`'bundled' | 'host'`); failed entries carry `error`
    (sanitized: host filesystem paths omitted when `HSQ_REMOTE=1`).
  - Add `hsq plugins` (runtime CLI command) listing loaded and failed plugins so operators can
    inspect plugin status and plugin-registered CLI commands without slowing `hsq --help`.

### 5. Built-in runners loaded through the same loader (C2)

- Each built-in runner folder `packages/cezar/src/runners/<id>/` gets an `index.ts` entry
  exporting `export default function register(api: SquawkPluginApi) { api.registerRunner(...); }`
  (plus an optional static display-order field or `display.order` so display order stays
  `claude, codex, opencode, pi, omp, antigravity`).
- `boot.ts` loads bundled runner plugins from the bundled `runners/` directory through the exact
  same loader and `SquawkPluginApi` before loading `<config>/plugins/`.
- `packages/cezar/src/runners/built-in.ts`, `packages/cezar/src/runners/ids.ts`, and
  `packages/cezar/src/lint/runner-ids-import.ts` are removed.
- Tests, `vitest.setup.ts`, lint rules (`runner-roster-literal.ts`, `runner-id-branch.ts`,
  `mock-scenario-boundary.ts`), and scripts read bundled runner ids via a zero-runner-import
  folder-discovery helper (`readdirSync` over `packages/cezar/src/runners/` filtering folders with
  an `index.ts` / `definition.ts`, sorted by display order or folder name). `core/runner-closure.test.ts`
  continues to verify zero runner code loads in `vitest.setup.ts` and the lint plugin.

### 6. Stored-config preservation (A3)

- Define a non-empty bounded runner-id string schema (`storedRunnerIdSchema`: trimmed non-empty
  string, max 64 chars, no control chars) for stored configuration files.
- `workspace/config.ts`:
  - `agentDefaults.runner`: decode with `storedRunnerIdSchema.optional().catch(undefined)`.
  - `disabledProviders`: keep every unique valid `storedRunnerIdSchema` string (ordering registered
    ids in registry order followed by preserved unknown ids in stored order).
- `workspace/agent-accounts.ts`:
  - `agentAccountSchema.provider`: decode with `storedRunnerIdSchema` and enforce
    `supportsProfiles(provider)` only when `isRegisteredRunner(provider)` is true (when unregistered,
    keep the row untouched so it survives restart and unrelated merge-writes).
- `config.ts`:
  - `defaultRunner`: decode with `storedRunnerIdSchema.default(DEFAULT_RUNNER_ID)` (runtime
    execution still maps unregistered ids to `DEFAULT_RUNNER_ID` via `resolveRunnerId`, without
    mutating stored config).
  - `defaultModels`: preserve keys for unregistered runner ids (like `registeredRunnerRecord`)
    while validating values for registered runners.
- HTTP write routes (`server/models-routes.ts`, `server/server.ts`, `server/runner-fields.ts`)
  continue to validate incoming runner ids against `knownRunnerIds()` and refuse unregistered ids.

### 7. Managed CLI installer layer and per-runner manifest parser (D1, hearsay-tools/squawk#4100)

- Move `packages/cezar/src/managed-install/` and the `/api/v1/runner-install/:runner` routes to
  `feature:runner-install` in `packages/cezar/src/lint/layers.json` (keeping
  `feature:server-install` for host setup only).
- Generalize `ManagedCliSource` (`core/managed-cli-source.ts`) so a runner supplies a manifest
  parser returning `{ version, url, digest: { algorithm, value } }` while `managed-install/`
  retains download-prefix checks, size bounds, digest verification, storage layout, and leases.
- Keep Antigravity behavior unchanged and add a fixture runner test with a distinct manifest shape.

## Case tables

### Boot and plugin loading cases

| Case | Boot path | Registries & plugins | Output / health / behavior |
| --- | --- | --- | --- |
| Cold command (`--version`, `job`, `artifact`, `message`, `webhook`, `automation`, `backup --help`, `remote-settings --help`, `worker list\|inspect\|collect\|wait`) | `bootColdCli()` | Only `cli-registry` sealed; zero plugins/runners/stores loaded | Exits identically to current `main`; `index-runners.test.ts` passes |
| `hsq --help` | `bootColdCli()` | Only `cli-registry` sealed; zero plugins loaded | Lists built-in commands + footer note pointing to `hsq plugins` |
| Built-in runtime command (`serve`, `run`, `init`, `discover`, `task`, `plugins`, etc.) | `bootRuntime()` | Built-ins + bundled runners + `<config>/plugins/*` loaded, then all registries sealed | Runs with built-in and plugin extensions active |
| Unknown command matching a plugin CLI command (`hsq my-cmd`) | `bootRuntime()` | Full boot loads plugins before `cli-registry` seals | Dispatches `my-cmd` registered by plugin |
| Unknown command matching no built-in or plugin (`hsq nope`) | `bootRuntime()` | Full boot finishes and seals all registries | Prints `unknown command: nope` + help, exit 1 |
| `<config>/plugins/` absent | `bootRuntime()` | Only built-ins + bundled runners loaded | Silent no-op; `health.plugins.failed` is `[]` |
| Valid plugin folder (`index.mjs` or `index.js`, default export function) | `bootRuntime()` | Runs in sorted folder-name order; staged entries commit on clean return | Listed in `health.plugins.loaded` and `hsq plugins` |
| Plugin folder missing `index.mjs` and `index.js`, or missing default function export | `bootRuntime()` | Skipped; zero registrations committed | Stderr warning naming folder + error; listed in `health.plugins.failed`; cockpit boots |
| Plugin throws synchronously or rejects asynchronously after calling `api.register*()` | `bootRuntime()` | Staged entries rolled back; zero leaked registrations in any registry | Stderr warning naming folder + error; listed in `health.plugins.failed`; cockpit boots |
| Plugin registers a key colliding with a built-in, legacy reserved key, or an earlier plugin | `bootRuntime()` | Entire plugin's staged batch rolled back (all-or-nothing); earlier registrations untouched | Stderr warning naming folder + conflicting key; listed in `health.plugins.failed`; cockpit boots |
| Plugin imports `@hearsay-tools/squawk/plugin` from outside repo `node_modules` | `bootRuntime()` | `registerHooks` resolves specifier to running Squawk copy | Shares single process state (`session-process`, `tool-names`, `runtime-home`); zero duplicate module copies |
| Hosted mode (`HSQ_REMOTE=1`) | `bootRuntime()` | Same host-folder loading; no cockpit install/remove routes | `GET /api/v1/health` omits host filesystem paths from plugin failure messages |

### Stored-config preservation cases

| Stored field | Runner plugin state on start | Read behavior | Subsequent unrelated write | Runtime / HTTP behavior |
| --- | --- | --- | --- | --- |
| `workspace/config.ts` `agentDefaults.runner` | Unregistered (plugin failed/absent) | Preserved as stored string | Preserved on disk | Execution resolves via `resolveRunnerId` -> `claude`; HTTP PATCH still refuses writing an unregistered id |
| `workspace/config.ts` `disabledProviders` | Unregistered entry alongside registered ones | Preserves both registered and unregistered ids | Preserved on disk | Cockpit ignores unregistered ids until plugin returns; HTTP PATCH refuses adding a new unregistered id |
| `workspace/config.ts` `agentDefaults.models` | Unregistered runner key | Preserved via `registeredRunnerRecord` | Preserved on disk | Ignored while unregistered; active again when plugin loads |
| `workspace/agent-accounts.ts` `accounts[]` row | Unregistered `provider` | Row preserved verbatim (skips `supportsProfiles` refusal while unregistered) | Row preserved on disk | Excluded from active registered runner listings while unregistered; HTTP POST refuses creating an account for an unregistered runner |
| `workspace/agent-accounts.ts` `accounts[]` row | Registered `provider` with `supportsProfiles === false` | Row dropped by per-entry salvage (unchanged guarantee) | Dropped on next write | Rejected on HTTP POST (unchanged) |
| `workspace/agent-accounts.ts` `selections` | Unregistered runner key | Preserved via `registeredRunnerRecord` | Preserved on disk | Active again when plugin loads |
| `config.ts` repo `defaultRunner` & `defaultModels` | Unregistered runner id | Preserved in decoded config | Preserved on disk | Task execution falls back to `DEFAULT_RUNNER_ID` via `resolveRunnerId`; HTTP settings write refuses unknown runner id |

## Implementation record

*(Updated as each slice merges; finalized in slice E1.)*
