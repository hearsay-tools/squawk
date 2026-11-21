# Runner definitions
Status: done

Step 1 of [the plugin core roadmap](2026-11-18-plugin-core-roadmap.md), epic
hearsay-tools/squawk#3824. Baseline: `main` at `535ce2bdd`. The owner decided the four open
points, and a fifth raised in review, on 2026-11-18 in task def1eade, and amended decision 5 on
2026-11-20. [ADR 0067](../../docs/adr/0067-register-each-runner-as-one-definition.md) records the
decision. The plan that cut the work into slices was deleted when the last slice merged; the
[implementation record](#implementation-record) lists the slices and what each one decided.

## Goal

Each runner is one definition in its own folder, and one call registers it. The built-in
runners register through the same call that a later outside runner uses
([ADR 0065](../../docs/adr/0065-define-the-core-by-a-layer-map.md), rule 1). After this step:

- a registry in core replaces the `switch` in `core/runner-factory.ts`;
- the service, the contract and the cockpit read runner data from the registry, not from a
  table keyed by runner id;
- a fixture runner registers in a test, runs a task and passes the parity kit, with no edit to
  another source file;
- `AGENT_PROTOCOL.md` §10, the new-runner checklist, names only the runner's folder, its scripts
  in `packages/cezar/scripts/` (the mock script, its data files and any helper the runner ships),
  its line in `runners/built-in.ts` and its id in `runners/ids.ts` (decision 5 as amended; D2a
  to D2f).

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
14 of those uses are `Record<RunnerId, …>` types; some are the per-runner tables this step
moves, others are catalog options and partial maps that stay with their readers and take a
`string` key.

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
   catches a misspelled runner id in core code. The registry check covers ids that arrive in a
   request; a misspelled literal inside the service is not caught, and `createRunner` gives it
   the Claude runner, as an unknown id gets today. `cez/runner-id-branch` keeps code outside
   `core/` from comparing runner ids, which leaves few such literals.

   **Amended (owner, 2026-11-20).** `runners/ids.ts` keeps the built-in ids as plain data, so
   that a test can name them without loading a definition. The owner chose this option with one
   condition, verbatim: "A, but I would add one condition: a check that no production file
   imports it. Without that, it can grow back into the closed list that decision 5 removed. If
   step 4 brings folder discovery, both lists go away then." `core/runner-registry.test.ts`
   holds the ids of `runners/ids.ts` equal to `BUILT_IN_RUNNERS`. The lint rule
   `cez/runner-ids-import` enforces the condition for static and literal imports: it fails a
   production file that names `runners/ids.ts` with a literal path in a static import or export,
   an `import()`, an `import x = require()`, a type import or any call. Its limit: a path built
   from pieces, such as `` import(`../runners/${'ids'}.ts`) ``, is outside its static scope. A new built-in runner
   therefore also adds its id to `runners/ids.ts`.
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

As built: file names keep their runner prefix. Each part's plain data is in its own data file
(`runners/<id>/facts.ts`, `spec-support.ts`, `models.ts` and the others). The definition and the
adapter both read the data file; the adapter never imports `definition.ts`, because the
definition imports the adapter. The pi RPC wire (`pi-rpc-wire.ts`, `pi-rpc-turn.ts`) is in
`runners/pi/`; OMP and the Codex hook mapper import it across folders. Those files reach no
other runner's adapter, so `core/runner-closure.test.ts` passes. Some runner-named files stay outside
`runners/`; [Known leftovers](#known-leftovers) lists them.

### The definition

`core/runner-definition.ts` (core) declares the type. Each runner's
`runners/<id>/definition.ts` exports one value made with `defineRunner`:

| Part | What it holds | Replaces |
| --- | --- | --- |
| `id` | The runner id | The `RUNNER_IDS` entry |
| `facts` | The wire and turn facts | The `RUNNER_FACTS` row |
| `display` | Display name, model list name, model id scope, runner picker label and line, icon name, install hint, login command, account folder example | `RUNNER_COCKPIT_FACTS`, `PROVIDERS`, `PROVIDER_INSTALL`, `FOLDER_EXAMPLE`, the icon map, `RUNNER_NAMES`, the runner picker's labels |
| `detection` | How to probe the CLI and read its version | The `RUNNER_PROBES` row; the binary and `*_BIN` override of the `AGENT_CLIS` row (`server/open-in-app.ts`) |
| `cli` | The executable and how to open it; the server installer's source; `openTarget`, the "Open in" menu entry's label and icon key | `RUNNER_CLI`, `AGENT_CLI_SOURCE`, the label and icon of the `AGENT_CLIS` row |
| `login` | Login and auth status arguments, install hint, executable | The `DESCRIPTORS` entry in `core/provider-auth.ts` |
| `loadLogin()` | `import()` of the status parser (`runners/<id>/login-probe.ts`) | The parser in that entry |
| `accounts` | Account folder layout, profile markers, home slot, and `homeDir(env, userHome)`, the runner's default home | `ACCOUNT_LAYOUT`, `PROFILE_DIR_MARKERS`, `AGENT_HOME_SLOT`, the per-runner entries of `AgentHomePaths` |
| `env` | The environment allow-list prefixes | The `BACKEND_ALLOW_PREFIXES` row |
| `models` | `suggested` (picker presets), `known` (ids that conflict with another runner), `retired`, the model id map (`idMap`), and `loadSettings()`, which reads the native default model | `MODELS_BY_RUNNER`, `KNOWN_PRESETS_BY_RUNNER`, `RETIRED_MODEL_IDS`, `BACKEND_MODEL_MAP`, `MODEL_SETTINGS_STRATEGIES` |
| `configFiles` | The native config files that Settings → Agent config shows, and the pane's groups: label, note, empty-state text, whether the MCP group shows the user-level MCP listing. A file's readers are the registered runners that list it | The row in `agent-config/catalog.ts`, the `AGENT_DESCRIPTORS` entry, the `runners` list of each file |
| `extraTools` | Extra tool grants | The `HARNESS_EXTRA_TOOLS` row |
| `specSupport` | Which `AgentRunSpec` fields the wire honors | `specSupport` on the runner class |
| `mock` | The native mock script and its scenario adapter, for tests and lint; `parityExemptions`, the parity cells this runner's wire cannot carry (A9 exactly where `facts.nativeAsk` is not `answerable`) | `MOCKS` in `core/skill-probe.ts`, the row in `lint/mock-scenario-boundary.ts`, the `HARNESS_ADAPTERS` row, the one-runner rows of `PARITY_EXEMPTIONS` |
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

As built, the definition has no `toolInjection` part. Only OpenCode needs more than the default
tool server setup, so that code moved into the OpenCode runner as `ciOpenCodeEnv`
(`runners/opencode/opencode-runtime-config.ts`); no shared code reads a per-runner injection.

### The registry

`core/runner-registry.ts` (core) holds the registered definitions in registration order:

- `registerRunner(definition)` adds one definition. A second definition with the same id is an
  error, and so is a definition whose id is a legacy id (`claude-cli`): the legacy map resolves
  that id to `claude` for saved runs, so no runner may take it. The same definition object
  registered again is a no-op, so an entry and a test can both register it.
- `runnerDefinition(id)`, `registeredRunners()` and `isRegisteredRunner(id)` read it. A read of
  an empty registry throws an error that names the missing registration, so a process entry that
  forgot it fails at once instead of falling back to Claude. `knownRunnerIds()` and
  `savedRunnerRegistration(id)` never throw: the stored-config decoders and the read of saved
  runs use them.
- `createRunner(id)` is async: it resolves the legacy id `claude-cli` to `claude`, picks the
  definition and awaits its `loadAdapter()`. An unknown id gets the Claude runner, as the
  `switch` gives today. Every factory caller awaits it, the Continue path in
  `launch-read-resolver.ts` included. After the await, a caller checks stop and cancel again
  before it changes state.
- The default runner (`claude`) and the legacy ids live with the registry, not in about 14 call
  sites that write `'claude'` by hand. As built, they are values in `core/runner-ids.ts`.

`runners/built-in.ts` lists the five built-in definitions and exports
`registerBuiltInRunners()`, which passes each to `registerRunner`. Each process entry calls it
before it reads config or runs a task. As built, that is one call in `src/index.ts`, before the
CLI dispatch, so every command, the cockpit, a headless task and each child process that reruns
the entry registers the built-ins (`index-runners.test.ts`). Scripts under
`packages/cezar/scripts/` that read runner data call it themselves.

`RUNNER_IDS` and `RunnerId` left the service in C3 (decision 5).
`cez/runner-id-branch` and `cez/runner-roster-literal` read the ids from `runners/ids.ts`, so the lint
plugin loads no runner module.
`runners/ids.ts` holds the same ids as plain data for tests (decision 5 as amended). A new
built-in runner adds its folder, its scripts in `packages/cezar/scripts/`, one line in
`runners/built-in.ts` and its id in `runners/ids.ts`; an outside runner (step 4) only calls
`registerRunner`.

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

As built (C1 option D, then C3; evidence on hearsay-tools/squawk#3897):

| Saved runner id | Read in a process that registered runners | Read in a process that registered no runner |
| --- | --- | --- |
| Legacy (`claude-cli`) | Maps to `claude`; keeps its session | Maps to `claude` |
| Retired (`REMOVED_RUNNER_IDS`, `cursor`) | Removed-runner run; the next write stores the fold, as before | Removed-runner run, as before |
| Registered | As written | Not possible: an empty registry registers nothing |
| Not registered and not retired | Removed-runner run for the read only. The next write puts the runner, sessions and step settings back where the write did not set them; a process that registers the runner reads the run as before. A queued run stays queued and untouched | As written: no fold and no refusal |

- The fold of an unregistered id is reversible, so a partial registry or a downgrade loses no
  saved data. `runs/unregistered-runner-saved-data.test.ts` pins it.
- A process that registered no runner has no opinion about a saved id (C3). This replaced C1's
  rule, under which such a process kept the old read and could not read the row. The
  `runs/store.test.ts` case for an unknown id keeps its expectation, because that test registers
  no runner; the registered-process case is in `unregistered-runner-saved-data.test.ts`.
- Edge: when a run's only trace of an unregistered runner is a step of its workflow definition
  that never ran, a Continue on another runner rewrites the row, and the run reads as removed
  again until a second Continue. No data is lost.
- `waitsForUnregisteredRunner` (`legacy-run-rows.ts`) tells such a run from a retired one. The
  queue watchdog and the queued revival leave it alone.

### The contract and the cockpit

- `runnerSchema` becomes `z.string().min(1)`. `UiBackend` in both copies becomes `string`.
  Every reader of `runnerSchema.options` (contract `delegation.ts`, `workflows.ts`,
  `workspace.ts`, `health.ts`; cockpit `lib/provider-status.ts`; the e2e specs) and of
  `RUNNER_COCKPIT_FACTS` (`new-task-form.ts` and the others) changes in the same slice, so the
  cockpit compiles after it.
  `RUNNER_COCKPIT_FACTS` leaves the contract; `runnerDisplayName` and `runnerModelListName`
  read the route's data in the cockpit and the registry in the service.
- The contract gains `runnersResponseSchema` (`packages/contract/src/runners.ts`): a list of
  `{ id, displayName, modelListName, modelIdScope, pickerLabel, pickerDescription, icon,
  installHint, loginCommand, accountFolderExample, models: { suggested, retired }, agentConfig:
  { label, note, groups } }`. Each group carries `id`, `label`, `note`, `empty` and
  `showsUserMcp`. As built, `models.known` is not sent: only the service reads it
  (`core/model-presets.ts`), and the cockpit's conflict check reads the other runners'
  `suggested` and `retired` ids. C2 added `pickerLabel` and `pickerDescription` to the `display`
  part with the removal of the cockpit's `RUNNERS` list. The file filter stays in the cockpit: it matches a file's
  `runners`, `kind` and `holdsMcp`, which the agent config route already sends, so a settings
  file that holds MCP servers (Codex `config.toml`, OpenCode's config) still shows in the MCP
  group.
- `GET /api/v1/runners` is a workspace route. It reads the registry and never probes a CLI.
- Each cockpit table keyed by runner id goes. A component reads the runner's entry from the
  route's query (`useRunners()`, `packages/web/src/api/runners.ts`).
- As built, the new-task composer waits for the runners query as it waits for the provider
  status, because the usable runners need the registered list. A failed runners query reads as
  "Provider authentication could not be verified.", the text of a failed provider status.
- A browser spec that stubs the API must also stub `GET /api/v1/runners`, or its pickers stay
  disabled (C2 fixed the completion-controls spec this way).

### Stored config

Decision 1 checks a runner id in workspace config when a request arrives. As built, the stored
config decoders also check ids against the registry when a file loads (B2, then C3):

- A per-runner record keeps the handling of unknown keys that its schema had before:
  `defaultModels` in `config.ts` drops a key that no runner registered; `agentDefaults.models`
  (`workspace/config.ts`) and the account selections (`workspace/agent-accounts.ts`) keep it
  and ignore it (`registeredRunnerRecord`).
- A single id drops an id that no runner registered: `agentDefaults.runner`,
  `disabledProviders` and an account row's `provider`. The next write stores what the decoder
  read.

All built-in runners register before any config read, so no setting is lost today. A runner that
does not register (an outside runner that failed to load, from roadmap step 4) loses those
settings on the next write. That is a one-way door for step 4; the
[roadmap](2026-11-18-plugin-core-roadmap.md#step-4-loader-and-package-format) lists it as a
precondition.

### The parity kit

The kit (`core/harness-parity-*.testkit.ts`, `workflows/waits-parity-fixture.testkit.ts`) takes
a definition in place of a runner id. Its mock adapter comes from the definition's `mock` part.
A fixture runner, `runners/fixture/` (test files only), wraps a small mock script. A test
registers it, runs one task and runs the kit on it.

As built (D1, in two parts):

- A test registers only the runners it drives. No setup file registers every runner. A file
  that needs every built-in runner imports `core/register-all-runners.testkit.ts`; a cross-runner
  static test table reads `core/runner-fact-rows.testkit.ts`; a test that needs only the ids
  reads `runners/ids.ts`.
- `MOCKS` (`core/skill-probe.ts`) reads the registry, and `lint/mock-scenario-boundary.ts`
  reads the ids from `runners/ids.ts` and parses `script` from each `runners/<id>/mock.ts`.
- The fixture runner is `runners/fixture/` plus `packages/cezar/scripts/mock-fixture-runner.mjs`.
  `runners/fixture/fixture-runner.test.ts` runs a task to review and the kit rows S1, S2, S3, S4,
  S7, S10 and S20, the rows whose scenarios its mock declares. The rows that need a
  wire-specific scenario do not run on it.
- The fixture commit changed no file outside `runners/fixture/` and its mock script. Before it,
  `parity-classes.testkit.ts` needed one change (`runsOn`), because the kit's runner roster was
  static.

As built (D2a to D2f), no test or lint list names the built-in runners by hand:

- The lint rule's runner classes (`RUNNER_CLASSES`, `lint/owner-reader-rules.ts`), the
  closure guard's adapter paths, the registry test's class check and the cross-runner fact rows
  come from the runner folders. `runnerDataRows` (`core/runner-data-rows.testkit.ts`) imports
  `runners/<id>/<file>` for each id in `runners/ids.ts`, in plain Node and in Vitest.
- An owned-workflows parity file may load exactly one other runner for R14's mixed chain, not
  the next runner in id order, so a new runner needs no neighbor's edit.
- `PARITY_EXEMPTIONS` keeps the rows it selects by facts and the rows that span every runner but
  one (S21, F11; R44 and R45 select by `transport` since D2f). A row for one runner is in that runner's `mock.parityExemptions`.
  A9 must be declared exactly where `facts.nativeAsk` is not `answerable`. The wait kit's
  `ACK_WIRES` comes from each runner's `inputDelivery.acknowledgement` fact.
- Each runner's folder holds its test data: `session-wire.testkit.ts`,
  `ui-mapper-row.testkit.ts` and `__fixtures__/golden.json` (`core/runner-golden.testkit.ts`). The
  `automation-tools-<id>` and `runner-skill-trigger-<id>` parity files moved into it. The mocks'
  skill captures are in `packages/cezar/scripts/mock-skill-data/<id>.mjs`, found by reading that
  folder, because the mocks run as separate processes and the package does not ship `src`
  fixtures.
- A built-in runner's mock script must import `mock-scenario.mjs`
  (`cez/mock-scenario-boundary`).
- The parity test kits branch on a runner's declared facts and data in the cells D2f migrated;
  D1 and R35 still branch on a runner id (hearsay-tools/squawk#3998). The
  mock part gained `scenarioEnv` (the env of a scenario that acts before the first prompt),
  `sessionStore`, `selfSettledApprovalEcho` and `missingSession`; the golden gained `askKinds`
  (R26, D2d), `toolGrant`, `skillWarningNotes`, `postParkChildFrames`, `rejectedAgentInput`,
  `runtimePlugins` and `systemPromptOnResume`; the session-wire readers gained `prompts`,
  `steers`, `systemPrompt` and `skillTriggers`. `driveSeam` no longer names a runner's mock
  variables.
- Cells that still run on one named runner skip a new runner with the same wire:
  hearsay-tools/squawk#3998.

## Case tables

### State restore cases

The new-task form and the runner pickers restore a saved runner and model (C2).

| Path or trigger | Restored value | Displayed value |
| --- | --- | --- |
| Reopen the form with no saved selection | `resolveRunner` picks from the usable runners and the preferred runner, as today | That runner's display name and first preset |
| A saved runner that is registered and usable | That runner and its saved model | Its display name and the model |
| A saved runner that is no longer registered | `resolveRunner`'s pick, as for a saved runner that is not usable today | The picked runner; the saved id is not shown |
| A saved model that is a suggested or retired preset of another runner whose `modelIdScope` is `own` | Discarded by `modelConflictsWithRunner`, as today, now reading the `suggested` and `retired` ids from the route | The runner's own preset |
| The runners query has not answered yet | Nothing yet | The picker is disabled, as it is while `health` loads |
| The runners query failed | Nothing | The picker is disabled; the reason reads "Provider authentication could not be verified." |
| A run saved on an unregistered runner | The run's own runner id | `removedRunnerLabel(id)`; Continue asks for another runner |

No other case table in the [template](TEMPLATE.md#case-tables) applies: this step adds no
cross-run relationship, run state, tool-grant mapping, worktree write or detached process.

## Implementation record

Epic hearsay-tools/squawk#3824. Every slice merged as one squash commit on `main`.

| Slice | Issue | Pull request | Commit on `main` |
| --- | --- | --- | --- |
| A1. `AgentSession` type imports | hearsay-tools/squawk#3891 | hearsay-tools/squawk#3904 | `c29508eb0` |
| A2. Definition type, registry, built-in list | hearsay-tools/squawk#3892 | hearsay-tools/squawk#3932 | `2d06ed70c` |
| B3. Models, skills, config files, extra tools | hearsay-tools/squawk#3895 | hearsay-tools/squawk#3933 | `b46c039dd` |
| B1. Spec support, detection, CLI, install source | hearsay-tools/squawk#3893 | hearsay-tools/squawk#3949 | `85f9455d5` |
| B2. Login, accounts, home paths, environment | hearsay-tools/squawk#3894 | hearsay-tools/squawk#3953 | `87da207e5` |
| CI gate fix for B4: carry a moved clone | none | hearsay-tools/squawk#3959 | `d5dd041bc` |
| B4. Move each runner into its folder | hearsay-tools/squawk#3896 | hearsay-tools/squawk#3960 | `9b5394c4a` |
| D1, part 1. Parity kit on a definition | hearsay-tools/squawk#3899 | hearsay-tools/squawk#3965 | `67d95ddd1` |
| C1. Runners route and open runner id | hearsay-tools/squawk#3897 | hearsay-tools/squawk#3966 | `08b5cff1e` |
| C2. The cockpit reads the route | hearsay-tools/squawk#3898 | hearsay-tools/squawk#3967 | `a5bd6f5d6` |
| C3. No closed runner list in the service; types-only `core/agent-runner.ts` | hearsay-tools/squawk#3936 | hearsay-tools/squawk#3978 | `18ea24e89` |
| D1, part 2. Tests register their runners; fixture runner | hearsay-tools/squawk#3899 | hearsay-tools/squawk#3984 | `a7f6a2a08` |
| D2a. Derive the built-in runner guard lists from the runner folders | hearsay-tools/squawk#3900 | hearsay-tools/squawk#3988 | `af4992f21` |
| D2b. Read open-in-app CLIs and parity exemption reasons from the definitions | hearsay-tools/squawk#3900 | hearsay-tools/squawk#3991 | `47a6af77c` |
| D2c. Read the runner roster from the registry or the runner folders in tests and mock data | hearsay-tools/squawk#3900 | hearsay-tools/squawk#3992 | `e9d059ab6` |
| D2d. Read R26 ask kinds from runner data; add the complete-runner simulation | hearsay-tools/squawk#3900 | hearsay-tools/squawk#3994 | `aacdcdc59` |
| D2f. Branch the parity test kits on declared facts and runner data | hearsay-tools/squawk#3900 | hearsay-tools/squawk#3997 | `68837249e` |
| D2e. Derive agent home slots and the shared `AGENTS.md` entry from the definitions | hearsay-tools/squawk#3900 | hearsay-tools/squawk#3996 | `b4820bb08` |
| D2. ADR, docs, spec close-out | hearsay-tools/squawk#3900 | The pull request that set this spec to done | |

After phase A, the `runner` entries of `layer-import.baseline.json` went from 13 to 7; after
phase B, to 0. After C1, `runner-roster-literal.baseline.json` holds no entry.

### Decisions made during the work

The planner and the coordinators made these slicing and design decisions. None changes what a
runner does.

- **The cut changed** (planner, after phase B; hearsay-tools/squawk#3897). C3 was added: it took
  the removal of `RunnerId`, `RUNNER_IDS`, `isRunnerId` and `runnerIdOf` from C1, because that
  removal touched the same files as the values split of `core/agent-runner.ts`. The values moved
  to `core/agent-runner-values.ts`, the default and legacy ids to `core/runner-ids.ts`.
  `RunnerDefinition.id` became a `string`. `RUNNER_FACTS` became a read-only view of the registry,
  read at each access. The contract enums in the service decode through the registry
  (`registeredRunnerIdSchema`, `core/runner-id-schema.ts`).
- **D1 was split** (hearsay-tools/squawk#3899). Part 1 moved the parity kit onto the `mock` part.
  Part 2 came after C3: it narrowed the tests that read every runner (D1's third done-when
  criterion, held until C3 removed `RUNNER_IDS`) and added the fixture runner.
- **C2 and C3 ran in parallel.** C2 owned the field blocks of `core/runner-definition.ts` and
  put the Agent config pane data in the `configFiles` part; this spec names the route's fields.
- **Data files.** Each part's plain data is in `runners/<id>/<part>.ts`. The definition and the
  adapter both read it; the adapter never imports `definition.ts`. A definition imports only
  types and data, and code parts load through `load*()`. A module that reads the registry while
  it loads throws, so a table built at import became a read at call time.
- **Registration.** The same definition object registered twice is a no-op. After the awaited
  adapter load, the caller checks stop and cancel again before it changes state.
- **Tests register what they drive** (A2, D1). No setup file registers every runner.
  `core/register-all-runners.testkit.ts` is the one test module that registers all built-ins;
  `core/runner-fact-rows.testkit.ts` holds cross-runner static test tables.
- **No `toolInjection` part** (B3). The OpenCode tool server setup is OpenCode code
  (`ciOpenCodeEnv`, now `runners/opencode/opencode-runtime-config.ts`).
- **Model lists moved, not copied** (B3, C2). `models.suggested` and `models.retired` were added
  in C2, in the change that deleted the cockpit lists, so the lists never existed twice. The
  cross-package clone check refuses a copy.
- **Display data** (C1, C2). C1 moved only the `RUNNER_COCKPIT_FACTS` values into `display`. C2
  added the picker label and line and the accounts pane's install hint, and put the Agent config
  pane data in the `configFiles` part as `agentConfig`.
- **Stored config** (B2, C3). Each per-runner record kept its schema's handling of an unknown id;
  single ids drop an unregistered id. [Stored config](#stored-config) has the rules.
- **B4 moves.** File names keep their runner prefix. `pi-rpc-*` files are in `runners/pi/`; OMP
  and the Codex hook mapper import them across folders. The renamed `file-length.baseline.json`
  keys kept the counts on `main` at B4 dispatch (1,211 for the Codex adapter and 1,653 for the
  OpenCode adapter, after B1 lowered them from 1,238 and 1,680). `moduleImports()`
  (`core/module-imports.testkit.ts`) resolves the cell kits' imports against the `core/` and
  `workflows/` folders that keep the shared kits.
- **Saved runs** (C1, C3). [Saved runs](#saved-runs) has the rules. The `runs/store.test.ts`
  case for an unknown id did not change; the registered-process case is in
  `runs/unregistered-runner-saved-data.test.ts`.
- **Lint messages** (C1). The `cez/runner-roster-literal` message and `docs/sdlc/lint.md` tell a
  Node-free package to read `GET /api/v1/runners`.
- **The cockpit waits** (C1). The new-task composer waits for the runners query, and a failed
  query reads as "Provider authentication could not be verified." (a C1 review finding).
  A browser run in the merge queue found a spec stub without `GET /api/v1/runners`
  (`completion-controls`); C2 fixed it.
- **`runners/ids.ts`** (C3 review, then the owner on 2026-11-20). See decision 5 as amended. The
  lint rule `cez/runner-ids-import` covers non-test files in `packages/cezar/src`, except the
  lint rules that read the ids (`runner-roster-literal`, `runner-id-branch`,
  `mock-scenario-boundary`), and catches literal paths only (see decision 5). The dev scripts `packages/cezar/scripts/parity-rows.ts` and
  `.ai/scripts/mock-wire-evidence.ts` read the file and are outside the rule.
- **Fixture runner** (D1 part 2). See [The parity kit](#the-parity-kit).
- **The guard lists follow the folders** (D2a to D2c, after review round 1 of D2 found that a new
  built-in runner still edited test and lint lists outside the four places). The planner chose
  to derive the lists in code rather than to name them in §10. [The parity kit](#the-parity-kit)
  says what changed. §10 and ADR 0067 first said "its mock script and that script's data files"
  (planner, 2026-11-20), because the mock skill captures sit beside the mock script. After D2d
  they say "its scripts in `packages/cezar/scripts/` (the mock script, its data files and any
  helper the runner ships)", because a complete runner can ship a helper, such as OpenCode's
  task-scope plugin.
- **Homes and shared config files** (D2e). The home slot is data in the `accounts` part, and
  `accounts.homeDir(env, userHome)` in the definition resolves the runner's default home.
  `AgentHomePaths` is a record that `agentHomePaths()` (`paths.ts`) builds from
  `registeredRunners()`, and `agentHomeDir(provider, env)` reads one entry. The resolver is
  named `homeDir`, not `resolveHome`, because `cez/home-boundary` reserves `resolveHome` for
  Squawk's own home. A config file's readers are the registered runners that list it in
  `configFiles.files`; `PROJECT_AGENTS_FILE` (`runners/project-agents-file.ts`) holds no runner
  list. The Claude-only MCP lookup is skipped when Claude is not registered.
- **Open in app** (D2b). The `AGENT_CLIS` hand list in `server/open-in-app.ts` is gone. The
  menu reads the registered runners at call time: the binary from `detection.binary`, the
  override from `detection.binOverride()`, read on each call, and the label and icon from
  `cli.openTarget`. The order is the registration order.
- **Criterion 7 of the epic** (a new runner needs no edit outside its own files) is proved by
  `.ai/scripts/simulate-sixth-runner.mjs`, which adds a runner to a scratch clone in the four
  places and fails when any other file changed. Its default mode adds `sixth`, the fixture runner
  under production names, which is incomplete. `--complete` (D2d) adds `hexacode`, a copy of
  `runners/opencode/` with its mock scripts, shipped scripts and skill data under a new id. Test
  failures fall in three classes: A, the runner lacks a piece that a real runner adds in its own
  folder; B, a list outside the four places that the runner must edit; C, anything else.
  Criterion 7 passes when both runs pass the typecheck, every printed test file passes in the
  complete run (the copy is complete, so no A; a C is a fault of the script), and the
  four-places run fails only with A failures plus `FACT_VALUE_TESTS`. On `e9d059ab6` the four-places run gave 26 A, 1 B and 0 C.
  The B was `FACT_VALUE_TESTS`, which the planner ruled by design: it is keyed by fact value, not
  by runner, and a new value of a turn-path fact (`TURN_PATH_FACTS`) needs a shared-code unit
  test (§10). Exit run, on `main` at `b4820bb08` with
  `.ai/scripts/simulate-sixth-runner.mjs`, both modes: criterion 7 passes. `--complete`
  (`hexacode`, a copy of `runners/opencode/`): the typecheck passes and all 133 roster test files
  pass; no B failure. Four places (`sixth`): the typecheck passes and 77 of 104 files pass; the 27
  failures are 26 A failures, each naming a missing piece inside `runners/sixth/` or its scripts,
  and `FACT_VALUE_TESTS` (`core/parity-classes.test.ts`), by design. No B and no C failure.

### Test selection

Roadmap rule 5 asks each step to count the test files that Squeal selects. Squeal's observed
paths never leave its store, so a file that lost its runtime imports still selects the tests that
loaded it before. The planner accepted the C3 measure on Squeal's static closure
(es-module-lexer rules, type-only imports dropped), with the evidence on
hearsay-tools/squawk#3936:

| File | Static closure (server tests) | Through declared inputs |
| --- | --- | --- |
| `core/agent-runner.ts` | 0 of 1,233 | 97 e2e, 5 root unit |
| `core/runner-registry.ts` | 1,010 of 1,233, plus 110 observed only | 97 e2e, 5 root unit |

Every `src` file selects about 101 test files through declared inputs (97 e2e, 4 root unit),
whatever it imports. Until Squeal prunes stale observed paths, later steps measure with the
static closure.

### Known leftovers

These runner-named files stay outside `runners/` (hearsay-tools/squawk#3960). They are tests,
testkits or shared code that a later change may move:

- `core/skill-resume-*-parity.test.ts`, `core/workflow-followup-codex-*-parity.test.ts`,
  `core/owned-input-delivery-opencode-*.test.ts` and `core/mock-{omp,opencode}-*.test.ts`;
- `workflows/codex-startup-cancel.test.ts`,
  `workflows/pi-teardown.test.ts`, `workflows/__fixtures__/codex-no-turn.mjs`,
  `workflows/fixture-claude.testkit.ts` and `workflows/worker-wait-claude.testkit.ts`;
- `delegation/provision-claude-layouts.test.ts`;
- `agent-config/model-settings/{claude,codex,opencode,pi}.ts`, which the definitions' `models.loadSettings()` import;
- the shared kits that keep a runner prefix in their names: `harness-autosave-*`, the
  `harness-parity-*` cells and parts and the `waits-parity-*` kits.

`core/hook-items.ts` and `core/own-lookup.ts` stay in `core/`; the Codex hook mapper imports
them.
