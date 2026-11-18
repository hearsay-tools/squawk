# Runner definitions
Status: active

Step 1 of [the plugin core roadmap](2026-11-18-plugin-core-roadmap.md), epic
hearsay-tools/squawk#3824. Baseline: `main` at `535ce2bdd`. The owner decided the four open
points, and a fifth raised in review, on 2026-11-18 in task def1eade. The [plan](2026-11-18-runner-definitions-plan.md) cuts
the work into slices.

## Goal

Each runner is one definition in its own folder, and one call registers it. The built-in
runners register through the same call that a later outside runner uses
([ADR 0065](../../docs/adr/0065-define-the-core-by-a-layer-map.md), rule 1). After this step:

- a registry in core replaces the `switch` in `core/runner-factory.ts`;
- the service, the contract and the cockpit read runner data from the registry, not from a
  table keyed by runner id;
- a fixture runner registers in a test, runs a task and passes the parity kit, with no edit to
  another source file;
- `AGENT_PROTOCOL.md` §10, the new-runner checklist, names only the runner's folder, its mock
  script and its line in `runners/built-in.ts`.

This step changes no runner behavior. It moves declarations and the code that reads them.

## Evidence

Measured on `main` at `535ce2bdd` (2026-11-18). The epic's Agent context comment has the full
inventory; this section keeps the counts that the acceptance criteria name.

| Item | Count |
| --- | --- |
| Runners in `RUNNER_IDS` (`core/agent-runner.ts`) | 5: `claude`, `codex`, `opencode`, `pi`, `omp` |
| `layer-import.baseline.json` entries with the `runner` reason | 13 |
| `runner-roster-literal.baseline.json` entries | 1 (`packages/contract/src/runner.ts`) |
| Non-test files in the `runner` layer (`lint/layers.json`) | 47, plus `core/host-skill-catalog.ts` |
| Service files with a table that has one row for each runner | 18, plus `DESCRIPTORS` (`core/provider-auth.ts`), `hostSkillCatalogAdapters`, `MOCKS` (`core/skill-probe.ts`) and `specSupport` on each runner class |
| Contract files with such a table | 3: `runner-facts.ts` (`RUNNER_COCKPIT_FACTS`), `per-runner-optional-strings.ts`, `workspace.ts` |
| Cockpit tables keyed by runner id | `MODELS_BY_RUNNER` and `RETIRED_MODEL_IDS` (`routes/new-task-form.ts`), `PROVIDER_INSTALL` (`accounts-section.tsx`), `FOLDER_EXAMPLE` (`add-account-dialog.tsx`), `PROVIDERS` with login commands and `providerWriteState` (`provider-settings.tsx`), the icon map in `open-in-menu.tsx`, `RUNNER_NAMES` (`tools-menu.tsx`), `AGENT_DESCRIPTORS` (`agent-descriptors.ts`) |
| Hand-written runner lists | `RUNNER_IDS`, the `switch` in `createRunner`, `runnerSchema` (contract), `UiBackend` in `core/ui-events.ts` and in `packages/api-client/src/protocol/ui-events.ts` |
| Parity test files that name one runner (`harness-<runner>-*`, `waits-<runner>-*`) | 105, each a short call into the shared kit |
| Steps in `AGENT_PROTOCOL.md` §10 | 12 |

Two process entries import `createRunner` and pass it on as a `RunnerFactory`:
`serve-command.ts` and `headless-run.ts`. Four places call the factory:
`workflows/run/step-session.ts`, `workflows/run/launch-read-resolver.ts` (the Continue path,
through `launch-settings.ts` into `continuation-session.ts`), `planner.ts` and
`runs/auto-name.ts`. `cez/layer-import` lets only `core/runner-factory.ts` import a runner
file. The lint rule `runner-class-outside-factory` (`lint/owner-policies.ts`) lets only code
under `core/` construct a runner class, and `runner-class-rule.test.ts` scans `core/` for the
classes. `core/runner-closure.test.ts` bundles each per-runner parity file with esbuild, static
and dynamic imports included, and fails when its closure reaches another runner's adapter
(hearsay-tools/cezarion#2939).

`runs/store.ts` reads a saved runner through `storedRunnerSchema`, which accepts the built-in
ids and `claude-cli`. `runs/legacy-run-rows.ts` turns a run saved on a removed runner into a
`removedRunner` run, for the ids in `REMOVED_RUNNER_IDS` (`cursor`) only.

`cez/runner-id-branch` and `cez/runner-roster-literal` read `RUNNER_IDS` from the source text of
`core/agent-runner.ts`. The service names `RunnerId` in 46 non-test files and `RUNNER_IDS` in 18;
14 of those uses are `Record<RunnerId, …>` tables that this step moves into the definitions.

## Product decisions (owner, 2026-11-18)

1. **A runner id is an open string in the contract.** `runnerSchema` becomes a non-empty
   string. The server checks a runner id against the registry when a request arrives: run
   requests, automation definitions, provider requests and workspace config. An unknown id gets
   the same refusal that the enum gives today. A run saved on an id that no runner has still
   opens and shows the "(removed)" label (`removedRunnerLabel`), as hearsay-tools/squawk#3715
   made it for `cursor`; this step makes that path hold for any unregistered id.
5. **The core holds no closed list of runner names** (owner, 2026-11-18, after review). A
   built-in runner and an outside runner take the same path (ADR 0065, rule 1). `RunnerId` and
   `RUNNER_IDS` leave the service; a runner id is a `string` checked against the registry. The
   only list of built-in runners is `runners/built-in.ts`, one line for each runner. The
   step 4 loader, which finds plugins by folder, may replace that list. The compiler no longer
   catches a misspelled runner id in core code; the registry check at the request edge and
   `cez/runner-id-branch` cover it.
2. **The cockpit gets per-runner data from `GET /api/v1/runners`.** The route returns the
   registered runners in display order with their display data and model presets. The cockpit
   tables in [Evidence](#evidence) are removed. Runner pickers wait for this query, as other
   pickers wait for `health`. `GET /api/v1/health` stays as it is: its `checks` still report
   which CLIs are installed.
3. **The model preset lists live in the definition.** `KNOWN_PRESETS_BY_RUNNER` (service),
   `MODELS_BY_RUNNER` and `RETIRED_MODEL_IDS` (cockpit) move into each definition's `models`
   part. The lists keep their roles: the cockpit's picker suggestions and the service's known
   ids differ today (Codex suggests only `auto` but knows three ids), so the part holds
   `suggested`, `known` and `retired` as separate lists with today's values. The service reads
   them from the registry; the cockpit reads them from the route.
4. **A definition is one object whose costly parts load on demand.** Plain data is in the
   object. The adapter and the catalogs load through dynamic `import()`. `createRunner` becomes
   async.

## Design

### Where a runner lives

Each runner's files move to `packages/cezar/src/runners/<id>/`: the adapter, its mapper, wire,
catalogs, config readers, tests, parity test files and golden fixtures. The native mock scripts
stay in `packages/cezar/scripts/`, because the packaged CLI tests start them by path; the
definition names its mock script. `lint/layers.json` maps `runners/` to the `runner` layer.

### The definition

`core/runner-definition.ts` (core) declares the type. Each runner's
`runners/<id>/definition.ts` exports one value made with `defineRunner`:

| Part | What it holds | Replaces |
| --- | --- | --- |
| `id` | The runner id | The `RUNNER_IDS` entry |
| `facts` | The wire and turn facts | The `RUNNER_FACTS` row |
| `display` | Display name, model list name, model id scope, icon name, install hint, login command, account folder example | `RUNNER_COCKPIT_FACTS`, `PROVIDERS`, `PROVIDER_INSTALL`, `FOLDER_EXAMPLE`, the icon map, `RUNNER_NAMES` |
| `detection` | How to probe the CLI and read its version | The `RUNNER_PROBES` row |
| `cli` | The executable and how to open it; the server installer's source | `RUNNER_CLI`, `AGENT_CLI_SOURCE` |
| `login` | Login and auth status | The `DESCRIPTORS` entry in `core/provider-auth.ts` |
| `accounts` | Account folder layout, profile markers, home slot | `ACCOUNT_LAYOUT`, `PROFILE_DIR_MARKERS`, `AGENT_HOME_SLOT` |
| `env` | The environment allow-list prefixes | The `BACKEND_ALLOW_PREFIXES` row |
| `models` | `suggested` (picker presets), `known` (ids that conflict with another runner), `retired`, the model id map, how the native default model is read | `MODELS_BY_RUNNER`, `KNOWN_PRESETS_BY_RUNNER`, `RETIRED_MODEL_IDS`, `BACKEND_MODEL_MAP`, `MODEL_SETTINGS_STRATEGIES` |
| `configFiles` | The native config files that Settings → Agent config shows, and the pane's groups: label, note, empty-state text, whether the MCP group shows the user-level MCP listing | The row in `agent-config/catalog.ts`, the `AGENT_DESCRIPTORS` entry |
| `extraTools` | Extra tool grants | The `HARNESS_EXTRA_TOOLS` row |
| `toolInjection` | How Squawk's tool server reaches the runner, where the runner needs more than the default | The OpenCode branch in `ci-wait/injection.ts` |
| `specSupport` | Which `AgentRunSpec` fields the wire honors | `specSupport` on the runner class |
| `mock` | The native mock script and its scenario adapter, for tests and lint | `MOCKS` in `core/skill-probe.ts`, the row in `lint/mock-scenario-boundary.ts`, the `HARNESS_ADAPTERS` row |
| `loadAdapter()` | `import()` of the adapter module; returns an `AgentRunner` | The `case` in `createRunner` |
| `loadModelCatalog()` | `import()` of the model catalog adapter | The adapter map in `core/host-model-catalog.ts` |
| `loadSkillCatalog()` | `import()` of the skill list adapter | `hostSkillCatalogAdapters` |

A definition module imports only types and data. The adapter, the catalogs and their
dependencies load only through the `load*` functions. esbuild follows a dynamic `import()`
(`core/runner-closure.test.ts` bundles with it), so a module that imports a definition reaches
its adapter in the import graph. The
closure property of hearsay-tools/cezarion#2939 therefore rests on who imports definitions, not
on lazy loading:

- No `core` file imports a definition or `runners/built-in.ts`. The `cez/layer-import`
  exception for `core/runner-factory.ts` goes; no core file imports a runner file.
- A per-runner test imports its own runner's definition and registers it.
- `core/runner-closure.test.ts` stays the guard, with its paths moved to `runners/<id>/`.

The parts that the cockpit needs are plain JSON data. The route sends them as they are.

### The registry

`core/runner-registry.ts` (core) holds the registered definitions in registration order:

- `registerRunner(definition)` adds one definition. A second definition with the same id is an
  error.
- `runnerDefinition(id)`, `registeredRunners()` and `isRegisteredRunner(id)` read it. A read of
  an empty registry throws an error that names the missing registration, so a process entry that
  forgot it fails at once instead of falling back to Claude.
- `createRunner(id)` is async: it resolves the legacy id `claude-cli` to `claude`, picks the
  definition and awaits its `loadAdapter()`. An unknown id gets the Claude runner, as the
  `switch` gives today. Every factory caller awaits it, the Continue path in
  `launch-read-resolver.ts` included.
- The default runner (`claude`) and the legacy ids live here, not in about 14 call sites that
  write `'claude'` by hand.

`runners/built-in.ts` lists the five built-in definitions and exports
`registerBuiltInRunners()`, which passes each to `registerRunner`. Each process entry calls it
before it reads config or runs a task: the two entries that import `createRunner` today
(`serve-command.ts`, `headless-run.ts`), the CLI dispatch, and every other Node entry that reads
runner data. The slice that adds the registry lists the entries and tests each one.

Until slice C1, `RUNNER_IDS` stays in `core/agent-runner.ts` and a test holds the ids of
`runners/built-in.ts` equal to it. C1 removes `RUNNER_IDS` and `RunnerId` (decision 5); from
then on `cez/runner-id-branch` and `cez/runner-roster-literal` read the ids from
`runners/built-in.ts`. A new built-in runner adds its folder, its mock script and one line in
`runners/built-in.ts`; an outside runner (step 4) only calls `registerRunner`.

The lint rule `runner-class-outside-factory` lets a runner class be constructed only inside its
own runner folder, and `runner-class-rule.test.ts` scans `runners/`.

### Saved runs

`storedRunnerSchema` accepts any non-empty string. `legacy-run-rows.ts` runs before the schema
parse (`runs/store.ts`), so it first maps a legacy id (`claude-cli`) to its runner through the
registry's legacy map, and only then treats an id that is still not registered as a removed
runner, not only `cursor`. A run saved under `claude-cli` keeps its session id and transport, as
today; a test pins it. A run saved
on the fixture runner, read by a process that has not registered it, opens as a removed-runner
run.

### The contract and the cockpit

- `runnerSchema` becomes `z.string().min(1)`. `UiBackend` in both copies becomes `string`.
  Every reader of `runnerSchema.options` (contract `delegation.ts`, `workflows.ts`,
  `workspace.ts`, `health.ts`; cockpit `lib/provider-status.ts`; the e2e specs) and of
  `RUNNER_COCKPIT_FACTS` (`new-task-form.ts` and the others) changes in the same slice, so the
  cockpit compiles after it.
  `RUNNER_COCKPIT_FACTS` leaves the contract; `runnerDisplayName` and `runnerModelListName`
  read the route's data in the cockpit and the registry in the service.
- The contract gains `runnersResponseSchema`: a list of `{ id, displayName, modelListName,
  modelIdScope, icon, installHint, loginCommand, accountFolderExample, models: { suggested,
  known, retired }, agentConfig: { note, groups } }`. Each group carries `id`, `label`, `note`,
  `empty` and `showsUserMcp`. The file filter stays in the cockpit: it matches a file's
  `runners`, `kind` and `holdsMcp`, which the agent config route already sends, so a settings
  file that holds MCP servers (Codex `config.toml`, OpenCode's config) still shows in the MCP
  group.
- `GET /api/v1/runners` is a workspace route. It reads the registry and never probes a CLI.
- Each cockpit table keyed by runner id goes. A component reads the runner's entry from the
  route's query.

### The parity kit

The kit (`core/harness-parity-*.testkit.ts`, `workflows/waits-parity-fixture.testkit.ts`) takes
a definition in place of a runner id. Its mock adapter comes from the definition's `mock` part.
A fixture runner, `runners/fixture/` (test files only), wraps a small mock script. A test
registers it, runs one task and runs the kit on it.

## Case tables

### State restore cases

The new-task form and the runner pickers restore a saved runner and model (C2).

| Path or trigger | Restored value | Displayed value |
| --- | --- | --- |
| Reopen the form with no saved selection | `resolveRunner` picks from the usable runners and the preferred runner, as today | That runner's display name and first preset |
| A saved runner that is registered and usable | That runner and its saved model | Its display name and the model |
| A saved runner that is no longer registered | `resolveRunner`'s pick, as for a saved runner that is not usable today | The picked runner; the saved id is not shown |
| A saved model that is a known or retired preset of another runner whose `modelIdScope` is `own` | Discarded by `modelConflictsWithRunner`, as today, now reading presets and retired ids from the route | The runner's own preset |
| The runners query has not answered yet | Nothing yet | The picker is disabled, as it is while `health` loads |
| A run saved on an unregistered runner | The run's own runner id | `removedRunnerLabel(id)`; Continue asks for another runner |

No other case table in the [template](TEMPLATE.md#case-tables) applies: this step adds no
cross-run relationship, run state, tool-grant mapping, worktree write or detached process.
