# Agent runners and backends

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`AGENT_PROTOCOL.md` (the contract and the new-runner checklist), then `packages/cezar/src/core/agent-runner.ts`, `packages/cezar/src/core/runner-registry.ts` and the changed backend's `packages/cezar/src/runners/<id>/` folder

## Rules

Shared code outside `packages/cezar/src/core/` and `packages/cezar/src/runners/` reads a runner's declared facts (`RUNNER_FACTS`, `inputDelivery`, `systemPromptOnResume`; `AGENT_PROTOCOL.md` §1) to decide what a runner can do, never a runner id. Every backend implements `AgentRunner`/`AgentSession` and must pass both parity matrices: `ui-parity.test.ts` (mappers) and `harness-parity.test.ts` (runners, including each runner's `specSupport`). Runner prose never counts runners. `HSQ_DRY_RUN=1` (`CEZ_DRY_RUN` fallback) must keep working. The zero-config default includes unrestricted `Bash`, and each runner's `specSupport.toolGrant` says whether its wire honors the list (open-mercato/cezar#430).

Explicit-shutdown parity reads the declared `shutdownDescendants` scope and host containment
(`isSessionContained()`, hearsay-tools/squawk#1345): on contained hosts (Linux delegated cgroup v2,
Windows Job Objects), abnormal exits (S27 Stop, S28 forced `end()` escalation, S31 outside kill)
reap detached descendants while normal `end()` (S30) keeps detached daemons alive for
`process-group` runners. On non-contained hosts, `process-group` retains the detached-survivor
checks while `observed-tree` requires observed detached children to die after Stop, end escalation
and EOF exit after end (S27/S28/S30), with no S31 snapshot guarantee. Antigravity declares
`observed-tree`: a CLI command runs in its own session and survives the ACP process.

## Runner definitions

Each runner is one definition, registered with one call
([ADR 0067](../adr/0067-register-each-runner-as-one-definition.md); design in the
[runner definitions spec](../../.ai/specs/2026-11-18-runner-definitions.md)). Paths below are
relative to `packages/cezar/src/`.

### The definition

`core/runner-definition.ts` declares `RunnerDefinition`. Each runner's `runners/<id>/definition.ts`
exports one value made with `defineRunner`. A definition module imports only types and data; each
code part loads through a `load*()` function. A data file is read by both the definition and the
adapter; the adapter never imports `definition.ts`, because the definition imports the adapter.

| Part | File in `runners/<id>/` | What it holds |
| --- | --- | --- |
| `id` | `definition.ts` | The runner id, an open string |
| `facts` | `facts.ts` | The wire and turn facts that `RUNNER_FACTS` (`core/runner-facts.ts`) reads |
| `specSupport` | `spec-support.ts` | Which `AgentRunSpec` fields the wire honors |
| `detection` | `detection.ts` | The PATH name, the `*_BIN` override, the dry-run rule, the version banner and the hints. The "Open in" menu reads the binary and the override from here |
| `cli` | `cli.ts` | How a terminal starts and resumes the CLI, the installer's source and `openTarget`, the "Open in" menu entry's label and icon key |
| `login`, `loadLogin()`, optional `loadBrowserSignIn()` | `login.ts`, `login-probe.ts`, `browser-sign-in.ts` | Status, native terminal login arguments, optional browser consent/replay flow, and account-home/hint metadata |
| `accounts` | `accounts.ts`; `homeDir()` in `definition.ts` | The account folder layout, the profile markers and the home slot (its key in `AgentHomePaths`, which `agentHomePaths()` in `paths.ts` builds from the registered runners). `homeDir(env, userHome)` resolves the runner's default home |
| `env` | `env.ts` | The environment allow-list prefixes |
| `models` | `models.ts`; `loadSettings()` in `definition.ts` | `suggested` (picker presets), `known` (conflict check), `retired`, the `idMap` and an optional `quotaPool(model)`, which names the provider quota pool a model draws on so a usage-limit hold closes that pool only (hearsay-tools/squawk#4343). `loadSettings()` reads the native default model; a built-in runner that has one (all but `omp`) loads it from `runners/<id>/model-settings.ts` in its own folder, most on the kit's shared helpers (`@hearsay-tools/squawk/plugin/model-settings`) |
| `loadModelCatalog()`, optional `loadModelCatalogKey()` | `<id>-model-catalog.ts` | The host model discovery adapter, with optional native auth/build cache identity; requests can carry the selected account home |
| `loadSkillCatalog()` | `<id>-skill-catalog.ts` | The native skill list adapter |
| `configFiles` | `config-files.ts` | The native files that Settings → Agent config shows, and the runner's `agentConfig` pane. A file's readers are the registered runners that list it, so a shared file (`PROJECT_AGENTS_FILE`, `core/project-agents-file.ts`) names no runner |
| `extraTools` | `extra-tools.ts` | Tools added to the default list when a step sets no `allowedTools` |
| `mock` | `mock.ts` | The mock script file name in `packages/cezar/scripts/` (resolved at dry-run time through `nativeMockPath(mock)` from `@hearsay-tools/squawk/plugin/runtime`), its `*_BIN` variable, the scenario prompts, `askResumeCases`, `parityExemptions` (the parity cells this runner's wire cannot carry; A9 exactly where `facts.nativeAsk` is not `answerable`, and R77/UI2 exactly where `facts.hookEvents` is `none`), `scenarioEnv` (the env a scenario sets for this mock), `sessionStore`, `selfSettledApprovalEcho` and `missingSession` |
| `display` | `display.ts` | The display name, the model list name, the model id scope, the picker label and line, the icon key, the install hint, the login command and the account folder example |
| `loadAdapter()` | `<id>-runner.ts` (or the adapter's own name) | The `AgentRunner` class |

The folder also holds the runner's test data: `session-wire.testkit.ts` (how the mock's recorded
wire shows a session, its prompts, steers, system prompt and skill triggers), `ui-mapper-row.testkit.ts` (its row of the mapper robustness test)
and `__fixtures__/golden.json` (values that tests outside the runner pin). `runnerDataRows`
(`core/runner-data-rows.testkit.ts`) imports a per-runner data module, `runners/<id>/<file>`,
for each bundled runner id (`core/built-in-runner-ids.testkit.ts`): facts, extra tools, the mock part, the session wire and the
mapper rows. `runnerGolden` (`core/runner-golden.testkit.ts`) reads one runner's
`__fixtures__/golden.json` as a file. The session-wire and golden readers name the missing file
when a runner has none.

The definition has no tool-injection part. OpenCode's tool server setup is OpenCode code
(`ciOpenCodeEnv` in `runners/opencode/opencode-runtime-config.ts`).

### The registry

`core/runner-registry.ts` holds the registered definitions in registration order.

- `registerRunner(definition)` adds one. A different definition with a registered id is an error,
  and so is a legacy id (`claude-cli`, in `core/runner-ids.ts`). The same object registered twice
  is a no-op, before or after sealing. New registrations after sealing throw.
- `runnerDefinition(id)`, `registeredRunners()` and `isRegisteredRunner(id)` throw while the registry is
  unsealed, so an entry that forgot its boot boundary fails at once. `sealRunners()` is idempotent;
  `runnersSealed()` reports the lifecycle state. A sealed empty registry permits normal reads. `knownRunnerIds()` and
  `savedRunnerRegistration(id)` never throw: config decoders and the read of saved runs use them.
- `createRunner(id)` is async. It maps a legacy id, gives the default runner (`claude`) to an id
  that no runner registered, and awaits the definition's `loadAdapter()`. After the await, a
  caller checks stop and cancel again before it changes state.
- `bootRuntime()` (`boot.ts`) loads the bundled runners through the plugin loader
  (`loadBundledRunners` in `plugin/loader.ts`) before the host plugins and before it seals. A
  bundled runner is a folder `runners/<id>/` whose plugin entry `index.ts` (`index.js` in `dist/`)
  registers its definition and declares `export const displayOrder = <integer>;`; they load and
  list in that order and report as `bundled` in `hsq plugins` and health. A bundled runner that
  fails to load stops boot. A script that reads runner data calls `loadBundledRunners()` and then
  `sealRunners()`.
- There is no list of built-in definitions. `plugin/bundled-runners.ts` reads the bundled runner
  folders and their display order as files and imports no runner code, so `vitest.setup.ts`, the
  lint rules (`cez/runner-id-branch`, `cez/runner-roster-literal`, `cez/parity-runner-subset`,
  `cez/mock-scenario-boundary`) and scripts read the ids without loading a runner; tests read them
  as `BUILT_IN_RUNNER_IDS` (`core/built-in-runner-ids.testkit.ts`). No lint rule imports a runner
  definition: Squeal relints the whole project when the lint plugin's import closure changes
  (`core/runner-closure.test.ts`).
- No core file imports a runner file (`cez/layer-import`). A runner class is built only inside its
  own folder (`runner-class-outside-factory`).
- A runner folder reads core code only through the runner kit, `@hearsay-tools/squawk/plugin`
  (`plugin/runner-kit.ts`), and never imports another runner's folder. Code that several runners
  share, such as the Pi-family RPC wire (`core/pi-rpc-wire.ts`, `core/pi-rpc-turn.ts`), lives in
  `core/` and the kit re-exports it. `cez/runner-core-import` fails a relative import out of a
  runner folder; `runner-core-import.baseline.json` holds 0 entries and only shrinks. Heavy helpers
  live on the kit's subpaths (`/runtime`, `/model-settings`, `/managed-cli`, `/pi-rpc`), so a
  `definition.ts` that imports the main entry keeps `bootRuntime()` light
  ([ADR 0070](../adr/0070-load-host-folder-plugins-and-export-the-runner-kit.md)).
- A runner outside the repository is a host plugin in `<config>/plugins/<name>/`: a plain-JS
  `index.mjs` or `index.js` whose setup calls `api.registerRunner(...)` and which imports Squawk
  only from the kit. It loads after the bundled runners, runs with all of Squawk's permissions,
  and is skipped, not fatal, when it fails. The kit is unstable until Squawk installs plugins from
  npm or git. [Plugins](../plugins.md) is the user guide.

### Self-contained runner folders

Every bundled runner folder (`runners/<id>/`) is self-contained so its built `dist/runners/<id>/`
folder loads and runs unchanged when copied into `<config>/plugins/` with no `node_modules`
ancestor ([ADR 0071](../adr/0071-keep-runner-folders-self-contained.md)):

- **Static guard (`cez/runner-folder-escape`).** Every non-test JS/TS file under `runners/<id>/`
  (`fixture/` and `__fixtures__/` aside) may import only `node:*` built-ins, files inside its own
  runner folder, and `@hearsay-tools/squawk/plugin*` (including `z` re-exported from the main
  entry). It may not escape its folder through `new URL(…, import.meta.url)`, `join`/`resolve`
  with `'..'` segments, or relative imports/exports/`require`. Each bundled runner keeps a
  shrink-only baseline file `lint/runner-folder-escape/<id>.baseline.json` (all empty).
- **Copy-out guard (`test/e2e/runner-copy-out.test.ts`).** Installs the packed tarball, copies
  every built `dist/runners/<id>/` folder into `<config>/plugins/` under a temp root with no
  `node_modules` ancestor, boots with an empty `bundledRunnersDir` via
  `test/e2e/support/hsq-without-bundled.mjs`, and runs a `HSQ_DRY_RUN=1` task on every runner.
- **Runner-owned `.mjs` assets.** Product scripts that an agent CLI loads (`runners/pi/extensions/*.mjs`,
  `runners/omp/omp-ci-wait.mjs`, `runners/opencode/opencode-task-scope.mjs`) live inside their
  runner folder and resolve through `new URL('./…', import.meta.url)`. Because `tsc` copies no
  `.mjs` files, `postbuild` runs `scripts/copy-runner-assets.mjs` to copy every non-test `.mjs`
  under `src/runners/<id>/` to the same path under `dist/runners/<id>/` (mirrored by
  `.ai/scripts/build-e2e.sh` and checked by `check:pack`).
- **Tool client (`HSQ_TOOL_CLIENT`).** `CiToolController.provision()` (`ci-wait/controller.ts`)
  adds `HSQ_TOOL_CLIENT` (with `CEZ_TOOL_CLIENT` fallback) to the session environment, pointing to
  the `file:` URL of the running copy's tool client (`src/ci-wait/client.ts` under source,
  `dist/ci-wait/client.js` when built). Out-of-process extensions (`pi-ci-wait.mjs`,
  `omp-ci-wait.mjs`) import the client from that URL instead of a relative path (`omp-ci-wait.mjs`
  keeps its source-checkout fallback to `dist/ci-wait/client.js`, derived from `HSQ_TOOL_CLIENT`).
- **Dry-run mocks (`nativeMockPath`).** Mock CLIs stay in `packages/cezar/scripts/`. Runner
  dry-run code and `core/skill-probe.ts` resolve `RunnerMock.script` through
  `nativeMockPath(mock)` from `@hearsay-tools/squawk/plugin/runtime`, which resolves the file name
  against the running installation's `scripts/` folder and throws an error naming the script when
  absent.

### Managed CLI installation

A `cli.installSource.managed` declares a host-target manifest and an HTTPS download
prefix. Settings → Agents installs, updates and removes it through
`/api/v1/runner-install/:runner`, gated by `settingsAdmin`. Reads return progress
without awaiting the network; manifests refresh at most hourly while the pane is
open, or on demand. Boot and task start never fetch a manifest. The managed CLI
is stored under `<data>/tools/<runner>/<target>/versions/`, with sealed releases
and an atomic `active.json`. See [the install design](../../.ai/specs/2026-11-22-managed-runner-cli.md).

`managedCliExecutable(home, runner, source)` from `managed-install/cli-installation.ts`
reads the active path without installing anything. A process caller uses
`leaseManagedCli(home, runner, source)` before spawn, then `bindProcess(pid)` and
`release()` after exit. Lease acquisition and pruning share the short data-root
lock. An update or removal retains a release until every live lease ends.

### The runners route

`GET /api/v1/runners` (`server/runners-routes.ts`, schema `runnersResponseSchema` in
`packages/contract/src/runners.ts`) sends the registered runners in registration order: each
`display` part, the `suggested` and `retired` lists of `models` and the `agentConfig` of
`configFiles`. It reads the registry and never probes a CLI; `GET /api/v1/health` still says which
CLIs are installed. The cockpit reads it through `useRunners()` (`packages/web/src/api/runners.ts`)
and holds no table keyed by runner id. The new-task composer and the runner pickers wait for this
query as they wait for the provider status. A failed query reads as "Provider authentication could
not be verified."

A request's runner id is checked against the registry when it arrives: run requests, automation
definitions, provider requests and workspace config (`core/runner-fields.ts`,
`core/runner-id-schema.ts`). An unknown id gets the refusal that the closed enum gave
(`server/unknown-runner-refusals.test.ts`).

### Saved runs and stored config

- A saved run reads its runner id through `runs/legacy-run-rows.ts` before the schema parse. A
  legacy id maps to its runner. An id in `REMOVED_RUNNER_IDS` is a retired runner; the next write
  stores the fold. Any other id that this process did not register folds to a removed-runner run
  for the read only: the next write puts the runner, sessions and step settings back, and a
  process that registers the runner reads the run as before. A queued run on such a runner stays
  queued. `runs/unregistered-runner-saved-data.test.ts` pins it. AGENT_PROTOCOL.md §10a lists the
  readers.
- A process whose runner registry is unsealed still maps a legacy id and folds a retired id. It
  reads any other saved id as written, even if some definitions have registered already. A sealed
  empty registry treats every non-legacy id as unregistered.
- The stored-config decoders (`config.ts`, `workspace/config.ts`,
  `workspace/agent-accounts.ts`) keep a runner id that no runner registered, so a runner whose
  plugin did not load keeps its settings. `agentDefaults.runner`, `disabledProviders`, the repo
  `defaultRunner` and `defaultModels` and an account row's `provider` check only the shared bound
  (`storedRunnerIdSchema`, `core/runner-id-schema.ts`); an account row checks `supportsProfiles`
  only for a registered runner. `agentDefaults.models` and the account selections
  (`registeredRunnerRecord`) keep every unregistered key as stored and validate only the values of
  registered runners. The next write stores what the decoder read.
  At run time an unregistered id is ignored or falls back to the default runner
  (`resolveRunnerId`), and HTTP write routes still refuse it.

### How tests register runners

No setup file registers every runner. A test registers the runners it drives with
`sealTestRunners(...definitions)` (`core/runner-registry.testkit.ts`). A test that imports a
default runner testkit seals after adding all its own definitions; default testkits register
without sealing. Dynamic registrations use `vi.resetModules()` and seal the fresh module graph
before reads. A test that needs every built-in runner (it enumerates
`runnersWhere` or `registeredRunners`) imports `core/register-all-runners.testkit.ts`, which registers and seals that complete roster. A test that
needs only the ids reads `core/built-in-runner-ids.testkit.ts`, which loads no definition. A static test table that
crosses runners reads the runner folders' data files, never a hand list:
`core/runner-fact-rows.testkit.ts` for facts and extra tools, `runnerDataRows` for the others.
The lint rule's runner classes and the closure guard's adapter paths come from the folders too. `runners/fixture/` is a runner that
exists only in tests: `runners/fixture/fixture-runner.test.ts` registers it, runs a task and runs
the parity kit on it. The per-runner parity files are in
[Runner regressions ship with shared coverage](#runner-regressions-ship-with-shared-coverage).

## Runner regressions ship with shared coverage

A lifecycle, input delivery, Needs You, monitoring, ASK or completion fix ships
with a parity row in the same PR, on the native mock wires through
`HARNESS_ADAPTERS`. Prove that the row fails without the fix. Do not defer this
coverage to a separate issue. Where the fix lives decides where its row runs
(hearsay-tools/cezarion#2991):

- **A fix inside a runner class** extends the seam contract suite
  (`core/seam-contract.testkit.ts`) or that runner's own rows. These run on every
  runner. Give a genuine wire gap a named executable exemption.
- **A fix above the seam**, in Squawk's shared code, extends a shared row. A
  shared row runs on one runner, `SCENARIO_RUNNER` (`fixture`, `runners/fixture/`), as
  [ADR 0063](../adr/0063-one-scenario-runner.md) records (hearsay-tools/squawk#4177). Shared code sees a
  runner through its turn-path facts (`inputDelivery.mode`, `.consumption`,
  `.acknowledgement`, `.humanInputAtTurnEnd` and `systemPromptOnResume`). The
  scenario runner shows one value of each. Every other declared value names the
  unit tests that drive shared code with it, in `FACT_VALUE_TESTS`. A fix whose
  behavior depends on such a value adds or extends one of those unit tests.
- **A new runner** adds what `AGENT_PROTOCOL.md` §10 lists: its self-contained folder (including
  any product `.mjs` extensions and its plugin entry `index.ts`), its empty
  `lint/runner-folder-escape/<id>.baseline.json`, and its mock scripts in `packages/cezar/scripts/`.
  [Runner definitions](#runner-definitions)
  names the file of each part. `display.icon` is a key of the cockpit's icon set (`OPEN_IN_ICONS`
  in `components/open-in-menu.tsx`, keyed by icon key, not by runner id); the generic runner icon
  is `bot`. A runner's `login.installHint` (the server's message) and `display.installHint` (the
  accounts pane) are different strings. When it declares a value of a turn-path fact (a key of
  `TURN_PATH_FACTS`) that no runner declared before, it also adds that value's unit tests to
  `FACT_VALUE_TESTS`.

`core/parity-classes.testkit.ts` holds the one classification table. Each parity
family is `every-runner`, `shared` or `no-session`, from a trace of its cells.
A family whose cells branch on a runner's own code, or read a narrow fact (native
ask, native subagents, the native timer tool, cumulative cost), is
`every-runner`. A shared row also runs on every runner when its family lists it
in `everyRunner`, when any runner is exempt from it, or when its cell title
carries no row id and its kit passes no row key to `parityRunners`. A kit that
passes a key (for example a mode name) runs that cell as a shared row. A `no-session` family runs once, on the scenario
runner. R1 and U1 stay on every runner as smoke rows. When unsure, choose
`every-runner` and say why in the table.

Three guards hold the rule:

1. `core/parity-classes.test.ts` fails when a declared value of a turn-path
   fact, other than the scenario runner's own, names no unit test in
   `FACT_VALUE_TESTS`, or names a file that is missing, is a parity file, or
   does not spell the value.
2. The `cez/runner-fact-combination` lint rule fails closed. It tracks no value:
   it flags a function in `packages/cezar/src/workflows/`, nested callbacks
   included, that touches any fact source (`.inputDelivery`, `.facts`,
   `.systemPromptOnResume`, `RUNNER_FACTS`, `inputDeliveryOf`, or the
   `InputDelivery` or `RunnerFacts` type) and reads two or more different fact
   keys from any object. Renamed imports and a source touched at module level
   count; its Limits list in `docs/sdlc/lint.md` names what it cannot see. The
   keys come from the declared types. A real
   combination needs a parity row that runs on every runner. Each reported
   function goes in the rule's `COMBINATION_ROWS` with a reason; a real
   combination also names its row as `<family> <row>`, and a false positive
   (an unrelated object with a same-named key) names none.
   `core/parity-classes.test.ts` fails an entry with no reason, or with a row
   that is not registered in that family or does not run on every runner.
3. `core/parity-classes.test.ts` fails when a parity test file belongs to no
   classified family, or a family has no file. It also fails when a registered
   row whose scenario runs runner code (`provider-error`, a native ask scenario,
   native subagents) does not run on every runner. A scenario is `shared` only when
   a seam contract row holds the runner's part of it on every runner, as S44 does
   for `provider-error-controlled`.

A parity test selects the runners a row covers from their declared facts:
`runnersWhere()` over `RUNNER_FACTS`, or `exemptWhere()` in
`core/harness-parity-core.testkit.ts` for an exemption. A changed facts row then
changes the expected result with no per-runner test edit. The
`cez/parity-runner-subset` lint rule fails a parity file that lists two or more
runner ids, but not all of them, by hand. A protocol quirk of one runner names
that one runner. `core/runner-fact-exemptions.test.ts` swaps facts rows and checks
that the exemptions follow (hearsay-tools/squawk#3642).

A per-runner parity file loads only its own adapter. It picks its runner with
`useRunners(onlyRunner(definition, make))`, which registers only that runner's definition, and
passes the definition to the kit: `describeHarnessParity({ runner: piRunner, part })`,
`describeWaitParity({ runner: piRunner, ... })`, `subagentCells([piRunner])`. `HARNESS_ADAPTERS`
(`core/harness-parity-core.testkit.ts`) reads each registered runner's `mock` part, and reading a
runner that is not registered throws. A test file registers only the runners it drives
(`registerRunner(definition)`), and where it would import a plain kit (`harness-parity.testkit`,
`fixture-cleanup.testkit`, `worker-wait.testkit`, `workflow-parity.testkit`,
`every-runner.testkit`) it imports the kit's `-core` file and `core/created-runners.testkit.ts`,
which makes `createRunner` the factory at the same point of the import order, so a
`vi.spyOn(createRunner)` still reaches it. `createRunner` gives Claude to an id that no runner
registered, so a test that starts a runner it did not register runs it on Claude without an error:
register every runner a test starts. A file that needs every built-in runner registered (it
enumerates `runnersWhere` or `registeredRunners` and expects all of them) imports
`core/register-all-runners.testkit.ts`, which registers every bundled runner's plugin entry
(`core/bundled-runners.testkit.ts`) and seals;
`core/every-runner.testkit.ts` is that module plus `created-runners.testkit.ts`. A test that
needs only the ids reads `BUILT_IN_RUNNER_IDS` from `core/built-in-runner-ids.testkit.ts`, which
loads no definition. The
testkits it reaches import a kit's `-core` file, never another runner's plugin entry or
definition or a kit's plain name (`fixture-cleanup`, `worker-wait`, `harness-parity`,
`workflow-parity`), which chooses every adapter. A wait parity file runs its workers on the fixture
runner, so built-in wait files load no other built-in runner adapter; an owned-workflows file loads
one other built-in runner for R14's mixed chain, and an automation-tools file loads Claude. Every
fixture parity file under `runners/fixture/` loads `FixtureAdapter` and no built-in runner adapter
or definition. `core/runner-closure.test.ts` enforces this
(hearsay-tools/cezarion#2939, hearsay-tools/squawk#4177). A guard like it reads imports through
`core/module-imports.testkit.ts`, never a regex: [lint.md § Syntax scans read a syntax tree](../sdlc/lint.md#syntax-scans-read-a-syntax-tree).

The binding limit on a parity test file is CI's per-file cap: `FILE_DURATION_LIMIT_MS`
(60 s) in `.github/scripts/vitest-file-duration.mjs`. CI enforces it on every Vitest
file when `VITEST_FILE_DURATION_CAP=1` (`.github/workflows/ci.yml`), with coverage on,
which runs about 1.8 times slower than an idle local host. Keep each file at most
about 25 s on an idle host. Measure a file the way CI does with
`VITEST_FILE_DURATION_CAP=1 npx vitest run --project server --coverage <files>`.
Squeal's per-file timeout (`runner.timeoutMs` in `squeal.config.json`) is a looser,
secondary bound. When a parity suite grows past the cap, run its cells from one file per
runner, defined once in a `*-cells.testkit.ts`, and add a guard that every runner
with rows has its file. Split a runner's file again by row group when one runner
alone is too slow. A runner that runs no row of a part has no file for it, so the
file guards compute the expected files from the class table, never from
`BUILT_IN_RUNNER_IDS` alone. Fold files that were split only for the cap once fewer rows
run, and measure each folded file against the CI cap first:
`WAIT_FOLDS` in `workflows/waits-parity-catalog.testkit.ts` groups the every-runner wait parts of
each built-in runner, and `SHARED_WAIT_FOLDS` groups the shared wait parts on `runners/fixture/`.
`core/harness-parity-cells.testkit.ts` and
`workflows/waits-parity-cells.testkit.ts` are the examples
(hearsay-tools/cezarion#1288). Squeal re-runs a test file when any file it imports changes, so
keep each part's cells in its own module and let a per-runner file import only its part's or
fold's module. The wait parity cells do this: `workflows/waits-parity-<part>-cells.testkit.ts`,
`workflows/waits-parity-<fold>-fold.testkit.ts`, one shared fixture and a catalog, and the full
registry for the guard file only (hearsay-tools/cezarion#3242). Vitest 4 fails a suite that registers no test,
so the file that runs the guard and the single-runner cells must not register
a `describe` whose body holds only runner cells; `describeRunners` in
`core/harness-parity-cells.testkit.ts` is the example
(hearsay-tools/cezarion#1375).

## Native mock wire evidence

Build the service once (`npm run build -w @wjarka/cezarion`), then run:

```sh
npm run mock:wire -- .ai/qa/wire-a
npm run mock:wire -- .ai/qa/wire-b
diff -ru .ai/qa/wire-a .ai/qa/wire-b
```

The collector drives the real runners through `HARNESS_ADAPTERS`. Its explicit
recipes live in `.ai/scripts/mock-wire-evidence.ts`; they use direct native mock
tokens, not the parity catalog's aliases. Optional trailing arguments select a
runner and a scenario, for example `npm run mock:wire -- .ai/qa/wire claude untokened`.
Its separate Vitest config keeps it out of the default unit suite.

Each runner/scenario pair produces normalized NDJSON. `summary.json` lists the
transcript count per runner and every unsupported recipe with its reason. The
collector overwrites the selected transcripts; use a fresh directory for each
comparison. Transcripts are PR evidence, not committed fixtures. This recorder
slice compares two runs on its head. Later encoder slices record on their base
and head and explain every difference.

`CEZ_MOCK_WIRE_FILE` enables recording in the native mocks. With it unset, no
recorder import runs. Records name stdout, stderr, SSE or the HTTP response
(status and body). Normalization replaces process-local identities, timestamps,
temporary paths, pids and allocated ports. It keeps frame and write order.
The evidence endpoint uses the real Squawk tool definitions with stable
unavailable receipts; it creates no waits and makes no GitHub requests. Parity
tests continue to verify tool effects through the real workflow controller.

A recipe ends on its last expected record. Child-after-park recipes release the
park gate after the parent's turn end and consume the late child output.
OpenCode delayed-ack recipes consume the HTTP acknowledgement after the SSE
turn events. Stalled recipes stop after the native acknowledgement, or after the pid file
and every frame the mock sends before it stalls. Gated recipes release
`input-ack.release` after the pid file, then consume the acknowledgement and
opening frames.
Terminating crash recipes record the leader's exit code or signal; clean crash
diagnostics end on the native turn end. Held-pipe children keep their inherited
stdio; only the mock's own writes and its leader exit enter that transcript.

Dry-run backend version banners use the release identity's environment prefix:
`mock (HSQ_DRY_RUN=1)`.
This display change does not change the accepted environment aliases.

## How it runs agents

Squawk shells out to your locally installed, logged-in agent CLI —
**your subscription, no API key**. With the default Claude Code backend that
means headless `stream-json` mode, tool access via `--allowedTools`, with
unapproved tools denied without prompting (`--permission-mode dontAsk`) inside
the task's worktree — but note the zero-config default list (`Read`, `Edit`,
`Write`, `Grep`, `Glob`, `Bash`) grants unrestricted `Bash` unless a step sets
`bashAllowlist`, so treat a run as having full shell access in its worktree,
not a sandboxed allowlist. Set `HSQ_APPROVAL_GATE=1` (`CEZ_APPROVAL_GATE` fallback) to opt into Claude's
interactive approval UI. Codex and OpenCode are driven through their
own native protocols and don't honor `allowedTools` at all; OpenCode's own
permission config decides what it asks. pi and OMP map `allowedTools` onto
their own tool allowlists — see
[Coding agent backends](runners.md#coding-agent-backends) for what each one actually
locks down. Nothing runs on a server you don't own.

Live Preview lets Chromium use host graphics when available. Chromium selects the
backend and falls back to software when hardware is unavailable or blocked. This
needs no Squawk setting or VirGL-specific setup. On Linux, GPU access may also
need a working display in the cockpit process environment. JPEG streaming is
unchanged; GPU rendering does not guarantee hardware frame encoding.

## Coding agent backends

Squawk is not married to one vendor. Every agent step runs through a single
`AgentRunner` seam with these built-in backends:

| Backend | CLI | How Squawk drives it | Tool access |
|---|---|---|---|
| **Claude Code** (default) | [`claude`](https://github.com/anthropics/claude-code) | Headless `stream-json` mode. | Per-tool `--allowedTools` (`bashAllowlist` scopes `Bash`); an empty `allowedTools` sends `--tools ""`, which removes every built-in tool, and pre-approves Squawk's own tools (other MCP tools follow the permission mode); `dontAsk` denies unapproved tools without prompting (`HSQ_APPROVAL_GATE=1` (`CEZ_APPROVAL_GATE` fallback) → `acceptEdits` + approval UI; `HSQ_CLAUDE_PERMISSION_MODE=bypass` (`CEZ_CLAUDE_PERMISSION_MODE` fallback) → `--dangerously-skip-permissions`). |
| **Codex** | [`codex`](https://github.com/openai/codex) | `codex app-server` — JSON-RPC over stdio, the same transport the Codex IDE extensions use. | Ignores `allowedTools`; inherits managed permissions and Codex approval defaults. Confirmed unmanaged sessions use `danger-full-access`. `HSQ_CODEX_NETWORK=0` (`CEZ_CODEX_NETWORK` fallback) requires network restriction: unmanaged sessions use network-blocked `workspace-write`; managed filesystem rules remain intact, and an unconfirmed network restriction stops before any turn. If requirements discovery is unavailable, Codex permission defaults apply. |
| **OpenCode** _(experimental)_ | [`opencode`](https://opencode.ai) | `opencode serve` — a local HTTP server with an SSE event stream. | Ignores `allowedTools` entirely; OpenCode's own permission config governs. Squawk answers OpenCode's built-in asks (outside-worktree reads, `.env` reads, the repeated-call guard) once, unless your config has a rule for that permission. Any other ask shows a permission card in the cockpit, and the run waits for your answer. |
| **pi** _(experimental)_ | [`pi`](https://github.com/badlogic/pi-mono) | Persistent `--mode rpc` over JSONL; models are picked with the `provider/model` convention. | Maps `allowedTools` onto pi tool names. The default list, which adds the harness extras `Subagent`, `SubagentSupervisor` and `SubagentWait`, sends no allowlist: `--no-builtin-tools` plus a bundled extension that activates those built-ins, so MCP servers (`direct`, `codemode` and `deferred` exposure) and other pi extensions' tools stay callable. The six base tools alone, the list a worker inherits from a Claude parent, take the same path. A narrowed `allowedTools`, or one that names any tool outside that default set (an `mcp__` tool, `WebFetch` or a custom tool), uses pi's `--tools` allowlist, so a step that grants named tools reaches only those; a list that maps to nothing becomes `--no-tools` (or only the Squawk tools). A configured `bashAllowlist` disables Bash because pi cannot express command-prefix rules. A reply whose text passes 64 KiB in one message is stopped by a bundled extension and retried once in the same session with a corrective prompt; a second one in the same turn fails the step (hearsay-tools/squawk#4236). |
| **OMP** _(experimental)_ | [`omp`](https://github.com/can1357/oh-my-pi) | Persistent `--mode rpc` over JSONL (Oh My Pi, a pi fork); models use the `provider/model` convention and are discovered from `omp models --json`. | Maps `allowedTools` onto OMP's `--tools` allowlist (`[]` becomes `--no-tools`); default sessions also pass `todo`, `lsp`, `ast_edit`, `task` and `wait`. A configured `bashAllowlist` disables `bash` because OMP cannot express command-prefix rules. `--tools` filters built-in tools only, so MCP and extension tools stay callable under a narrowed list. |
| **Antigravity** | The Google Antigravity CLI, installed from Settings → Agents > Install CLI (or `agy` on PATH, or `HSQ_ANTIGRAVITY_BIN`) | `antigravity acp --gemini-dir <account> --app-data-dir antigravity-cli` over ACP stdio. Uses the shared ACP layer. No interactive terminal handoff. Browser sign-in uses `settingsAdmin`, including host-granted hosted cockpits. | Native permission requests follow the task grant and Bash prefixes. Granted requests proceed; ungranted requests fail, or reach the approval card with `HSQ_APPROVAL_GATE=1`. A native `ask_question` reaches the question card. See [Antigravity tool access](#antigravity-tool-access). |

### Minimal sessions

A bookkeeping call, such as the task namer, sets `AgentRunSpec.minimal`. The runner then
turns off as much of the user's and the project's setup as it can: hooks, plugins, extensions,
skills, context files, MCP servers and session saving. Auth and model selection stay. What each
runner turns off differs. Its `*_SPEC_SUPPORT.minimal` row (`runners/<id>/spec-support.ts`) names its flags and what still loads:

- **Claude Code:** `--safe-mode --disable-slash-commands --no-session-persistence`. Not
  `--bare`, which accepts only API-key auth.
- **Codex:** thread config turns off hooks, plugins, apps, memories, subagents, AGENTS.md and
  web search, and the thread is ephemeral. Under a confirmed unmanaged policy, or when Codex
  cannot report its policy, the sandbox is `read-only`, because Codex ignores `allowedTools`. Skills and the user's MCP servers still load.
- **OpenCode:** `serve --pure`, the `OPENCODE_DISABLE_*` switches for project config, Claude Code
  files and external skills, a runtime config that turns every tool off and
  denies every permission, and a `*` deny session rule, set when the session is created or resumed
  and on each prompt. Session rules come after an agent's own permission rules, so a configured agent
  cannot allow a tool back.
  MCP servers in the user's global config, the global AGENTS.md, configured `instructions` and
  the default plugins, which carry the Codex and Copilot sign-in loaders, still load, and the
  session is saved.
- **pi:** `--no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files
  --no-mcp --no-session`, without the project-skills extension.
- **OMP:** `--no-extensions --no-skills --no-rules --no-context-files --no-lsp --no-session
  --no-title`. The user's MCP servers still connect.

> ⚠️ **OpenCode, pi and OMP support are experimental.** These runners work but are less
> battle-tested than the Claude Code and Codex backends, and OpenCode ignores
> `allowedTools` (its own permission config governs what it asks). Treat them as
> previews and expect rough edges.

On startup Squawk probes which CLIs are installed and the cockpit only offers
the backends it found — install any one of the five and you're operational.

### OMP (Oh My Pi)

Install [OMP](https://github.com/can1357/oh-my-pi) (`curl -fsSL https://omp.sh/install | sh`
installs a prebuilt binary; Bun is needed only for `--source`) and run `omp login`. Squawk discovers `omp` on PATH;
`HSQ_OMP_BIN` (`CEZ_OMP_BIN` fallback) overrides its location. `omp` is a separate backend from `pi`: a host with
both binaries keeps both, and `HSQ_PI_BIN` (`CEZ_PI_BIN` fallback) never selects OMP. Select **OMP** in the runner
picker to use a persistent `--mode rpc` session. A missing CLI leaves the other backends
available and shows OMP as unavailable. `HSQ_DRY_RUN=1` (`CEZ_DRY_RUN` fallback) uses the mock.

Agents ask questions through Squawk's `cezar_ask` tool, and OMP's own sub-agents appear in the
Agents drawer. Settings → Agent config exposes OMP's `config.yml`, `mcp.json` and
`AGENTS.md` files. Named OMP profiles and accounts are not supported.

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
runner and model selection; see [Owned workers](../workers.md#owned-workers).

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

### Antigravity tool access

Squawk runs the Google Antigravity CLI. It resolves the executable in this order:
`HSQ_ANTIGRAVITY_BIN`, the managed install's active release, then `agy` or `antigravity` on
PATH. On PATH it checks each entry until one is the CLI, off the event loop: `--help` starts `Usage of
antigravity:` and lists `acp`, and `--version` prints a bare version. Detection stamps and status reads use only finished
checks; a candidate that is not the CLI is never run as one. A session, a model probe
and a sign-in lease the managed release before spawn, bind the lease to the child at once and
release it after exit, so an update cannot remove a running release. The cockpit binds its
Home for these leases once, at its operator entry.

Every fresh or resumed session runs in `default` mode. Squawk answers native permission
requests from the tool grant and Bash command prefixes. Granted requests proceed; ungranted
requests fail. With `HSQ_APPROVAL_GATE=1`, ungranted requests reach the native approval card
instead. MCP tools arrive as `mcp_<server>_<tool>`; Squawk reads the server and tool from that
name, so its own `squawk` tools stay trusted. CLI 1.5.14 runs `read_file` with no permission
request, so a tool grant cannot withhold native file reads; a step whose grant lacks Read gets a
note that says so. A native
`ask_question` call ends the prompt with the question as text; Squawk shows it as a question
card that keeps the free-text answer, and sends the chosen answer as the next prompt.

Native subagents are off (`nativeSubagents: 'none'`). On CLI 1.5.14 a subagent's permission
requests never reach the ACP client, so its commands time out. Each session gets `--add-dir` for a
folder in its own temp folder, outside the checkout, whose `.agents/hooks.json` denies
`invoke_subagent`, `define_subagent`, `manage_subagents`, `send_message`, `run_workflow` and
`swarm`. The agent reads the denial and goes on; Squawk workers replace subagents. An added
folder leaves the command cwd on the checkout (docs/runners/antigravity-wire.md).

The CLI sends no result for a read, an MCP call or a subagent tool, and sends no hook frame on ACP. Squawk reads both from the
session's transcript in the account folder
(`antigravity-cli/brain/<session>/.system_generated/logs/transcript_full.jsonl`): missing tool results amend
the completed tool card (`item.updated` with `late: true`, which never counts as a reply to a
nudge), and injected hook messages (`SYSTEM_MESSAGE` rows with `source: "SYSTEM_SDK"`) emit
`item.completed` `UiHookItem` cards while internal `source: "SYSTEM"` reminders stay hidden, each bounded to 64 Ki characters. That file is the CLI's private format,
pinned for CLI 1.5.14 by goldens; when it is missing or changes shape, the card has no output and
the run goes on. The CLI writes a provider failure as the message `"\n⚠ <error>\n"`; when that
message is the turn's last work, the turn and the session fail. After an accepted `cezar_done` the
same error is a diagnostic and the run keeps its result.

The CLI keeps working after a turn ends: a background command or a `schedule` timer wakes the
idle session, which then streams, runs tools and can ask for permission with no prompt open.
Squawk maps that work to a new turn that the agent started (`nativePermission: 'after-turn'`).
A usage update right after message text ends it. A prompt sent while it runs joins it. A
steered prompt ends the running prompt at once and carries the turn; Squawk keeps one turn,
with the usage of both prompts. `schedule` is the native timer (`nativeTimerTool`), so its
delay lands in the wait list like `cezar_wait`.

The CLI saves the session/new system prompt with the session and appends a resent one, so
Squawk sends it on session/new only and never resends it on session/resume. A resumed session
gets it prepended to its opening turn instead, as Codex and OpenCode do
(`systemPromptOnResume: 'in-thread'`), so a Continue or a recovery still reads the current
instructions. When the CLI refuses `session/resume` (a session the retired registry server saved,
or a removed conversation), the runner opens a fresh session with the full system prompt and the
skill, and says so in a note.

Antigravity status reports credential presence. `GEMINI_API_KEY` (or `GOOGLE_API_KEY`, mapped
in the child) connects without an account folder; Settings names the environment source.
Without a key, a short ACP probe asks the CLI to authenticate `oauth-personal`. With
`SSH_CONNECTION` set, which Squawk always sets, the CLI refuses at once when the account holds
no Google sign-in and opens no browser. Status does not read credentials or validate them
against the API. Business and agent-platform sign-in are unsupported.

The CLI ignores `GEMINI_HOME`. Squawk passes the account folder as `--gemini-dir` (default
`~/.gemini`) and the app data folder `antigravity-cli`, the CLI's own default, so the default
account shares the terminal CLI's skills. `SSH_CONNECTION` makes the CLI keep a Google sign-in
in a file per account, `<gemini-dir>/antigravity-cli/antigravity-oauth-token`, instead of one OS
keyring entry for every account. Named accounts also set
their own `HOME`/`USERPROFILE` and `XDG_CONFIG_HOME`. Only native instruction files (`AGENTS.md`,
`GEMINI.md`), skill folders (`config/skills`, `antigravity-cli/skills`, `skills`), skill/plugin
manifests (`config/skills.json`, `config/plugins.json`), and plugins (`config/plugins`) link back to
the user's default Gemini home; existing account files are preserved.

Settings → Agents offers personal Google sign-in through `antigravity acp --login`. The
CLI prints a consent link whose redirect is `https://antigravity.google/oauth-callback`; that page
shows a code. The user pastes the code, or the full address of that page, into the same dialog.
Squawk accepts a bare code, or an address with this sign-in's single state and a single code, and
writes it once to the CLI's stdin. Codes, URLs and tokens are not logged or saved by Squawk; only
the CLI writes credentials inside the account. The flow expires after ten minutes and closes on
Cancel. Browser sign-in requires `settingsAdmin`: a local cockpit, or a loopback-hosted cockpit
whose operator granted its port with `hsq remote-settings enable`. The server never opens a host
browser. Account creation, editing and listing still require `localHandoff`.

Model discovery is lazy: a picker request opens one bounded ACP session in a temporary working
folder. With an API key it uses an empty Gemini folder, so discovery adds nothing to the account;
with a Google sign-in it uses the account folder. The probe reads `model` plus each model's
`thought_level` options; model ids pass through. No prompt/model turn runs. If a caller still
requests effort for a model without `thought_level`, or a level its options exclude, the runner
skips it with a notice. The memory cache key holds the executable's file identity, the account
folder and an in-memory credential digest; an update or a new sign-in discards the entry.
Discovery failure leaves suggested presets usable. Before a failed task or probe ends, Squawk
writes bounded stderr and the tail of the process's own CLI log
(`<gemini-dir>/antigravity-cli/log/acp-server-<time>-<pid>.log`) to the server log, redacted with
the sign-in diagnostic redaction.

Antigravity's private MCP bridge uses the short server alias `squawk` in its descriptor and
permission identities. The CLI qualifies tools as `mcp_<server>_<tool>` and drops a tool whose
name passes 64 characters; the shared per-session server name can exceed that limit. Other
runners keep the shared descriptor name.
The model definition declares `catalogAtAdmission: false`: worker/task admission and alternative-runner suggestions never start this expensive probe. Other runners retain their existing admission checks. Neither boot nor task start waits for this catalog. Skill discovery asks the Antigravity CLI natively (`--settings '{"modelProvider":"gemini"}' --output-format stream-json --print=/skills`) in a disposable `HOME` linked to the selected account home's read-only skill/plugin entries, with zero model turns or network calls (ADR 0066).
