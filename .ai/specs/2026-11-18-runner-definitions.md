# Runner definitions
Status: active

Step 1 of [the plugin core roadmap](2026-11-18-plugin-core-roadmap.md), epic
hearsay-tools/squawk#3824. Baseline: `main` at `535ce2bdd`. The owner decided the four open
points on 2026-11-18 in task def1eade. The [plan](2026-11-18-runner-definitions-plan.md) cuts
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
- `AGENT_PROTOCOL.md` §10, the new-runner checklist, names only files in the runner's folder.

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
| Cockpit tables keyed by runner id | `MODELS_BY_RUNNER` and `RETIRED_MODEL_IDS` (`routes/new-task-form.ts`), `PROVIDER_INSTALL` (`accounts-section.tsx`), `FOLDER_EXAMPLE` and `FOLDER_HINT` (`add-account-dialog.tsx`), the map in `provider-settings.tsx`, the icon map in `open-in-menu.tsx`, `RUNNER_NAMES` (`tools-menu.tsx`), `AGENT_DESCRIPTORS` (`agent-descriptors.ts`) |
| Hand-written runner lists | `RUNNER_IDS`, the `switch` in `createRunner`, `runnerSchema` (contract), `UiBackend` in `core/ui-events.ts` and in `packages/api-client/src/protocol/ui-events.ts` |
| Parity test files that name one runner (`harness-<runner>-*`, `waits-<runner>-*`) | 105, each a short call into the shared kit |
| Steps in `AGENT_PROTOCOL.md` §10 | 12 |

`createRunner` has three callers: `workflows/run/step-session.ts` (through `RunnerFactory`),
`planner.ts` and `runs/auto-name.ts`. `cez/layer-import` lets only `core/runner-factory.ts`
import a runner file. `cez/runner-id-branch` and `cez/runner-roster-literal` read `RUNNER_IDS`
from the source text of `core/agent-runner.ts`.

## Product decisions (owner, 2026-11-18)

1. **A runner id is an open string in the contract.** `runnerSchema` becomes a non-empty
   string. The server checks a runner id against the registry when a request arrives: run
   requests, automation definitions, provider requests and workspace config. An unknown id gets
   the same refusal that the enum gives today. A run saved on an id that no runner has still
   opens and shows the "(removed)" label (`removedRunnerLabel`), as hearsay-tools/squawk#3715
   made it. The service keeps a `RunnerId` type for the built-in ids, where the compiler helps.
2. **The cockpit gets per-runner data from `GET /api/v1/runners`.** The route returns the
   registered runners in display order with their display data and model presets. The cockpit
   tables in [Evidence](#evidence) are removed. Runner pickers wait for this query, as other
   pickers wait for `health`. `GET /api/v1/health` stays as it is: its `checks` still report
   which CLIs are installed.
3. **The model preset lists live in the definition.** `KNOWN_PRESETS_BY_RUNNER` (service),
   `MODELS_BY_RUNNER` and `RETIRED_MODEL_IDS` (cockpit) become one list in each definition. The
   service reads it from the registry; the cockpit reads it from the route.
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
| `display` | Display name, model list name, model id scope, icon name, install hint, account folder example and hint | `RUNNER_COCKPIT_FACTS` and the cockpit tables |
| `detection` | How to probe the CLI and read its version | The `RUNNER_PROBES` row |
| `cli` | The executable and how to open it; the server installer's source | `RUNNER_CLI`, `AGENT_CLI_SOURCE` |
| `login` | Login and auth status | The `DESCRIPTORS` entry in `core/provider-auth.ts` |
| `accounts` | Account folder layout, profile markers, home slot, identity source | `ACCOUNT_LAYOUT`, `PROFILE_DIR_MARKERS`, `AGENT_HOME_SLOT`, `IDENTITY_SOURCE` |
| `env` | The environment allow-list prefixes | The `BACKEND_ALLOW_PREFIXES` row |
| `models` | Known presets, retired ids, the model id map, how a default model is written to native config | `KNOWN_PRESETS_BY_RUNNER`, `MODELS_BY_RUNNER`, `RETIRED_MODEL_IDS`, `BACKEND_MODEL_MAP`, `MODEL_SETTINGS_STRATEGIES` |
| `configFiles` | The native config files that Settings → Agent config shows | The row in `agent-config/catalog.ts` |
| `extraTools` | Extra tool grants | The `HARNESS_EXTRA_TOOLS` row |
| `toolInjection` | How Squawk's tool server reaches the runner, where the runner needs more than the default | The OpenCode branch in `ci-wait/injection.ts` |
| `specSupport` | Which `AgentRunSpec` fields the wire honors | `specSupport` on the runner class |
| `mock` | The native mock script and its scenario adapter, for tests and lint | `MOCKS` in `core/skill-probe.ts`, the row in `lint/mock-scenario-boundary.ts`, the `HARNESS_ADAPTERS` row |
| `loadAdapter()` | `import()` of the adapter module; returns an `AgentRunner` | The `case` in `createRunner` |
| `loadModelCatalog()` | `import()` of the model catalog adapter | The adapter map in `core/host-model-catalog.ts` |
| `loadSkillCatalog()` | `import()` of the skill list adapter | `hostSkillCatalogAdapters` |

A definition module imports only types and data. The adapter, the catalogs and their
dependencies load only through the `load*` functions, so a test that drives one runner still
loads only that adapter (hearsay-tools/cezarion#2939). A test holds this: loading the registry
loads no adapter module.

The parts that the cockpit needs are plain JSON data. The route sends them as they are.

### The registry

`core/runner-registry.ts` (core) holds the registered definitions in registration order:

- `registerRunner(definition)` adds one definition. A second definition with the same id is an
  error.
- `runnerDefinition(id)`, `registeredRunners()` and `isRegisteredRunner(id)` read it.
- `createRunner(id)` is async: it resolves the legacy id `claude-cli` to `claude`, picks the
  definition and awaits its `loadAdapter()`. An unknown id gets the Claude runner, as the
  `switch` gives today.
- The default runner (`claude`) and the legacy ids live here, not in about 14 call sites that
  write `'claude'` by hand.

`runners/built-in.ts` lists the five built-in definitions and registers each through
`registerRunner`. The registry imports it once, on first read. `core/runner-registry.ts` takes
the place of `core/runner-factory.ts` as the one core file that may import a runner file
(`cez/layer-import`).

`RUNNER_IDS` stays as the list of built-in ids for the compiler, derived from the built-in list.
`cez/runner-id-branch` and `cez/runner-roster-literal` read the ids from `runners/built-in.ts`.

### The contract and the cockpit

- `runnerSchema` becomes `z.string().min(1)`. `UiBackend` in both copies becomes `string`.
  `RUNNER_COCKPIT_FACTS` leaves the contract; `runnerDisplayName` and `runnerModelListName`
  read the route's data in the cockpit and the registry in the service.
- The contract gains `runnersResponseSchema`: a list of `{ id, displayName, modelListName,
  modelIdScope, icon, installHint, accountFolderExample, accountFolderHint, models: { presets,
  retired } }`.
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
