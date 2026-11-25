# Register each runner as one definition

Approved design: [runner definitions](../../.ai/specs/2026-11-18-runner-definitions.md),
including the owner's five product decisions of 2026-11-18 and the amendment of decision 5 on
2026-11-20. Epic hearsay-tools/squawk#3824, step 1 of the
[plugin core roadmap](../../.ai/specs/2026-11-18-plugin-core-roadmap.md).
It applies rule 1 of [ADR 0065](0065-define-the-core-by-a-layer-map.md): a built-in runner and an
outside runner take the same path.

**Amended 2026-11-25** (hearsay-tools/squawk#4209, roadmap step 4): `runners/built-in.ts`,
`runners/ids.ts` and `cez/runner-ids-import` are removed. Each runner folder has a plugin entry
`index.ts`, and boot loads the bundled runner folders through the plugin loader
([plugin loader and runner kit](../../.ai/specs/2026-11-24-plugin-loader-and-runner-kit.md) § 5).
The rows and rules below that name the two lists record the step 1 design.

## Decision

Each runner is one object, its **definition**, in its own folder
`packages/cezar/src/runners/<id>/`. One call, `registerRunner(definition)`, adds it to the
**registry**. The core reads every per-runner value from the registry, never from a table keyed
by runner id.

| Piece | Path under `packages/cezar/src/` | What it does |
| --- | --- | --- |
| Definition type | `core/runner-definition.ts` | `RunnerDefinition` and `defineRunner`. Plain data parts, and `load*()` functions for the code parts |
| Registry | `core/runner-registry.ts` | `registerRunner`, `runnerDefinition`, `registeredRunners`, `isRegisteredRunner`, `knownRunnerIds` and async `createRunner` |
| Default and legacy ids | `core/runner-ids.ts` | `DEFAULT_RUNNER_ID` (`claude`) and `LEGACY_RUNNER_IDS` (`claude-cli` → `claude`) |
| A runner's folder | `runners/<id>/` | `definition.ts`, its data files, its adapter, mapper, catalogs, test data files, tests, parity files and fixtures |
| Built-in list | `runners/built-in.ts` | `BUILT_IN_RUNNERS`, one line for each built-in runner, and `registerBuiltInRunners()` |
| Built-in ids | `runners/ids.ts` | `BUILT_IN_RUNNER_IDS`, plain data for tests, testkits, `vitest.setup.ts` and dev scripts |

Rules:

1. **A runner id is an open string.** `runnerSchema` in the contract is a non-empty string. The
   server checks a request's runner id against the registry and gives the refusal that the
   closed enum gave.
2. **A definition module imports only types and data.** The adapter, the model catalog, the skill
   catalog, the login parser and the model settings reader load through `loadAdapter()`,
   `loadModelCatalog()`, `loadSkillCatalog()`, `loadLogin()` and `models.loadSettings()`. A
   data file `runners/<id>/<part>.ts` is read by both the definition and the adapter. The adapter
   never imports its own `definition.ts`, because the definition imports the adapter.
3. **No core file imports a runner file.** `cez/layer-import` enforces it. A process entry fills
   the registry: `src/index.ts` calls `registerBuiltInRunners()` before any command reads
   config or runs a task. A read that needs a definition throws on an empty registry, so an
   entry that forgot the call fails at once. `knownRunnerIds()` and `savedRunnerRegistration()`
   never throw: config decoders and the read of saved runs use them.
4. **The registry refuses conflicts.** A second definition with a registered id is an error,
   and so is a legacy id. The same definition object registered twice is a no-op.
5. **An unknown id still gets Claude.** `createRunner` resolves a legacy id, then gives the
   default runner to an id that no runner registered, as the old `switch` did.
6. **The core holds no closed list of runner names** (decision 5). `BUILT_IN_RUNNERS` is the
   only list of definitions. `runners/ids.ts` repeats the ids as plain data so that a test
   can name them without loading an adapter. `core/runner-registry.test.ts` holds the two lists
   equal. The lint rule `cez/runner-ids-import` (`lint/runner-ids-import.ts`) fails a non-test
   file in `packages/cezar/src` that names `runners/ids.ts` with a literal path: a static import
   or export, a literal `import()`, an `import x = require()`, a type import or any call with
   that literal. A path built from pieces, such as a template literal with a substitution, is
   outside its static scope. It exempts the lint
   rules that read the ids, `lint/runner-roster-literal.ts`, `lint/runner-id-branch.ts` and
   `lint/mock-scenario-boundary.ts`, so the lint plugin loads no runner module. Production code reads the registry. Without that rule the id list
   could grow back into a closed list. The dev scripts `packages/cezar/scripts/parity-rows.ts`
   and `.ai/scripts/mock-wire-evidence.ts` read `runners/ids.ts` and are outside the rule.
7. **The cockpit reads `GET /api/v1/runners`.** The route sends each registered runner's
   `display` part, its `models.suggested` and `models.retired` ids and the `agentConfig` pane of
   its `configFiles` part. The cockpit holds no table keyed by runner id.
8. **A test registers only the runners it drives.** No setup file registers every runner. A test
   that needs every built-in runner imports `core/register-all-runners.testkit.ts`.
   `core/runner-closure.test.ts` fails a per-runner test whose import closure reaches another
   runner's adapter (hearsay-tools/cezarion#2939). A test table that crosses runners reads each
   runner folder's data files, never a hand list of runners.

## Consequences

- A new built-in runner needs only `runners/<id>/`, its scripts in `packages/cezar/scripts/`
  (the mock script, its data files and any helper the runner ships), its line in
  `runners/built-in.ts` and its id in `runners/ids.ts`. `AGENT_PROTOCOL.md` §10 is the
  checklist. The folder holds the definition parts: the home slot and `accounts.homeDir()`, the
  native files that `configFiles.files` lists (a file's readers are the runners that list it),
  the "Open in" menu entry (`cli.openTarget`, label and icon key; the binary and its override
  come from `detection`), and the mock data (`mock.parityExemptions`, with A9 exactly where
  `facts.nativeAsk` is not `answerable`, and `scenarioEnv`, `sessionStore`,
  `selfSettledApprovalEcho`, `missingSession`). It also holds `session-wire.testkit.ts`,
  `__fixtures__/golden.json` and the other fixtures, and the per-runner parity files. The guard
  tests read these from the folders and name a missing piece. The parity test kits branch on
  declared facts and data, except the cells that still branch on a runner id (D1, R35;
  hearsay-tools/squawk#3998).
- A runner that declares a value of a turn-path fact that no runner declared before also adds a
  shared-code unit test for that value to `FACT_VALUE_TESTS`. That table is keyed by value, not
  by runner.
- Two proofs hold it. The fixture runner (`runners/fixture/`, test files only) registers in its
  test, runs a task and passes the parity kit. `.ai/scripts/simulate-sixth-runner.mjs` adds a
  runner to a scratch clone. By default it adds an incomplete one in the four places: the
  typecheck passes, and the printed test files fail only by naming a missing piece in the
  runner's folder, plus `FACT_VALUE_TESTS`. With `--complete` it copies a real runner's folder and
  scripts under a new id: the typecheck passes and every printed test file passes. The spec's
  implementation record has the exit run.
  Cells that a new runner skips because they still run on one named runner are
  hearsay-tools/squawk#3998.
- The compiler does not catch a misspelled runner id in core code. The registry check covers
  ids that arrive in a request. `cez/runner-id-branch` keeps code outside `core/` and `runners/`
  from comparing runner ids.
- A run saved on an id that no runner registered opens as a removed-runner run. For an id that
  only this process does not know, the fold is undone on the next write. A process that
  registered no runner still maps a legacy id and folds a retired id; it reads any other saved id
  as written.
- The stored-config decoders check ids against the registry. A runner that did not register
  loses its stored settings on the next write. A loader that registers runners later (roadmap
  step 4) must register every runner before it reads or writes config, or the decoders must
  keep unknown ids.
- Two lists of built-in runners remain: `runners/built-in.ts` and `runners/ids.ts`. The roadmap
  expects the step 4 loader, which finds runners by folder, to replace both.
- Some runner-named files stay outside `runners/` (hearsay-tools/squawk#3960). The spec lists
  them.

## Considered Options

- **Keep `RUNNER_IDS` and the `switch` in `core/runner-factory.ts`.** Rejected. A new runner
  edited about 20 places, and an outside runner could not join.
- **Keep `RunnerId` as a union type of the built-in ids.** Rejected by decision 5. A built-in
  runner would take a path that an outside runner cannot take.
- **Read the built-in ids in tests from `runners/built-in.ts` only.** Rejected for tests that
  must not load runner code: `runners/built-in.ts` imports every definition, and a definition
  reaches its adapter through `import()`.

Implementation and reader rules: [runners area](../areas/runners.md),
[AGENT_PROTOCOL.md §10](../../AGENT_PROTOCOL.md#10-adding-a-new-runner-the-387-pi-checklist).
Coverage under `packages/cezar/src/`: `core/runner-registry.test.ts`,
`core/runner-closure.test.ts`, `runners/fixture/fixture-runner.test.ts`,
`server/runners-routes.test.ts`, `server/unknown-runner-refusals.test.ts`,
`runs/unregistered-runner-saved-data.test.ts`, `index-runners.test.ts` and
`lint/ast-rules.test.ts` (`cez/runner-ids-import`).
The sixth-runner simulation: `.ai/scripts/simulate-sixth-runner.mjs`, tested by
`scripts/simulate-sixth-runner.test.mjs` (repository root).
