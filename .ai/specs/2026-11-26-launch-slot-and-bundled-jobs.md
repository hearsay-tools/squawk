# Launch slot and bundled jobs feature plugin
Status: active

Epic hearsay-tools/squawk#4309. Step 5 (first version) of
[the plugin core roadmap](2026-11-18-plugin-core-roadmap.md). Builds on
[ADR 0065](../../docs/adr/0065-define-the-core-by-a-layer-map.md),
[ADR 0068](../../docs/adr/0068-publish-a-run-lifecycle-and-reach-the-run-store-through-ports.md),
[ADR 0069](../../docs/adr/0069-adopt-register-then-seal-registries-for-extension-tables.md),
[ADR 0070](../../docs/adr/0070-load-host-folder-plugins-and-export-the-runner-kit.md), and
[ADR 0071](../../docs/adr/0071-keep-runner-folders-self-contained.md).
Baseline: `main` at `a1bfe21d2`. The owner settled all six product decisions on 2026-11-26
(task `62289188`). The working plan lives in
[2026-11-26-launch-slot-and-bundled-jobs-plan.md](2026-11-26-launch-slot-and-bundled-jobs-plan.md).
Paths are under `packages/cezar/` unless noted.

## Goal

Add a launch slot to the plugin API so features and host plugins contribute agent launch
environment variables and system-prompt parts without core imports, load bundled feature folders
through the plugin loader, and move `jobs` into the first bundled feature folder so nothing
outside `src/features/jobs/` imports it. After this epic:

- `SquawkPluginApi.registerLaunchPart` lets bundled features and host plugins contribute env
  entries and system-prompt parts to every agent launch;
- `src/workflows/run/launch-context.ts` and `src/workflows/run/session-events.ts` import no
  non-worker feature module, and `src/lint/layer-import.baseline.json` drops from 83 to 76
  entries;
- `src/plugin/loader.ts` discovers and loads bundled features under `src/features/<id>/index.ts`
  (`dist/features/<id>/index.js`), and `hsq --help` runs `bootRuntime()` so bundled feature and
  host plugin subcommands appear in help output;
- `jobs` lives in `src/features/jobs/`, registers its CLI command (`job`), deletion gate
  (`jobsDeletionGate`), and launch part (`jobs`) solely through `SquawkPluginApi`, and
  `cez/bundled-feature-import` forbids any non-test source file outside `src/features/<id>/` from
  importing inside it;
- `hsq plugins` lists `jobs` as a `bundled` plugin with its command, removal slot, and launch
  part;
- booting with the `jobs` folder absent completes a task whose launch prompt names no job
  command; booting with `jobs` present completes a live task that starts a background job with
  `hsq job start` that outlives the agent session;
- default-install launch prompt bytes and environment remain unchanged.

## Out of scope

- Moving features with HTTP routes, schedulers, or cockpit views (`automations`, `artifacts`,
  `webhooks`, `preview`, `forge`, `activity`) into `src/features/<id>/`: next epics of step 5.
  Here `automations`, `artifacts`, and `webhooks` use the launch slot from
  `src/built-in-launch-parts.ts` and nothing more.
- Slots for HTTP routes or server start/stop: next epic of step 5.
- Cockpit slots and moving cockpit views into plugins: step 6 (the cockpit rule of 2026-11-26 is
  already recorded in the roadmap by hearsay-tools/squawk#4310).
- Workers (`feature:workers`): `launch-context.ts` keeps its two type-only imports from
  `delegation/`; the layer map plans no removal for `feature:workers`.
- Loading a feature folder unchanged from outside the product (feature kit + copy-out test):
  later epic.
- Stabilizing the plugin API: remains unstable per ADR 0070 section 7.

## Done when

- **Outcome:** All four child issues (hearsay-tools/squawk#4312, hearsay-tools/squawk#4313,
  hearsay-tools/squawk#4314, hearsay-tools/squawk#4315) are closed, this spec is `Status: done`,
  the `-plan.md` file is deleted, ADR 0072 records the launch slot and bundled features (with
  ADR 0070 section 6 amended for `hsq --help`), and the roadmap records the Squeal rule-5 counts.
- **Proof:** `layer-import.baseline.json` holds 76 entries or fewer; `cez/bundled-feature-import`
  passes with zero baseline entries; `hsq plugins` lists `jobs` as `bundled` with its command,
  removal slot, and launch part; an automated acceptance test boots with an empty
  `bundledFeaturesDir` and completes a task whose launch prompt names no job command; a live
  acceptance run on a real runner CLI starts a job with `hsq job start` that outlives the agent
  session; default launch prompt and env tests pass unchanged.
- **Failure:** Any non-test source file outside `src/features/jobs/` that imports a file inside
  `src/features/jobs/` fails `cez/bundled-feature-import`; a present bundled feature folder that
  throws on import or setup stops boot; reading `core/launch-registry.ts` before `boot.ts` seals
  it throws; running `hsq job` when the `jobs` folder is absent fails with `unknown command: job`.

## Decisions

The owner settled all six product decisions on 2026-11-26.

### 1. One public launch slot on `SquawkPluginApi`

`SquawkPluginApi` adds `registerLaunchPart(definition: LaunchPartDefinition): void`. Built-in
features and host plugins in `<config>/plugins/` use the exact same API with no internal back
door (ADR 0065 rule 1). The API remains unstable until Squawk installs plugin packages from npm
or git (ADR 0070 section 7).

Each registration provides:

- `id: string`: unique non-empty key, checked transactionally by `runPluginSetup` alongside
  existing keyed registries.
- `order?: number`: optional finite number controlling evaluation and prompt order (decision 2).
- `contribute(context: LaunchPartContext)`: sync or async callback receiving `{ runId, dataDir,
  repoRoot, home, cockpit, env }` and returning `{ env?, prompt? }` or `undefined`.

`@hearsay-tools/squawk/plugin` (`src/plugin/index.ts`) exports `LaunchPartDefinition`,
`LaunchPartContext`, `LaunchPartContribution`, and `LaunchCockpitAddress`.

### 2. Feature-neutral numeric `order`

Launch parts run in ascending numeric `order`, defaulting to `100`. Ties break by registration
order. Core knows no feature names.

- Built-in features register with orders `10` (`automations`), `20` (`webhooks`), `30`
  (`artifacts`), and `40` (`jobs`).
- Outside plugins omit `order` (defaulting to `100`, placing them after built-in parts and before
  the core handoff contract) or pass any number.
- `launchSystemTail` composes `[extraSystemPrompt, delegation?.instructions, ...launchParts.prompts,
  handoffInstructions(...)]`, preserving the default install's system prompt byte-for-byte
  regardless of plugin folder load order.

### 3. Catch, warn, and skip failing launch-part callbacks

`resolveLaunchParts` runs each registered part sequentially in resolved order, folding returned
`env` entries into the cumulative read-only `env` snapshot passed to later parts. If any part's
`contribute` throws or rejects, `resolveLaunchParts` catches the error, logs one warning naming
the part `id`, and skips that part so the task still launches (zero-config degradation). Core env
preflight errors (`AgentTempDirError` in `agentTmpEnv`) remain in core `agentEnv` and still fail
the launch loudly.

### 4. Bundled feature folder layout, import boundary, and load failures

- **Folder layout:** Bundled features live in `src/features/<id>/index.ts` (built to
  `dist/features/<id>/index.js`), discovered in locale-independent ASCII code-point order of
  folder name (`src/plugin/bundled-features.ts`). Entry file lookup order is `index.mjs`,
  `index.js`, `index.ts`.
- **Import boundary:** In this epic, a bundled feature may import core modules by relative path
  (copying a feature folder outside the product requires a feature kit and is deferred). The
  reverse direction is strictly forbidden: `cez/bundled-feature-import` fails any non-test source
  file outside `src/features/<id>/` that imports any file inside `src/features/<id>/`.
- **Missing vs broken:** An absent or empty `features/` folder (or a missing `features/jobs/`
  folder) is not an error; boot succeeds without those features. A present bundled feature folder
  that fails to import or register throws and stops boot, matching bundled runners (ADR 0070
  section 4), because shipped product code is broken.
- **Test override:** `BootRuntimeOptions` gains a test-only `bundledFeaturesDir?: string` option
  parallel to `bundledRunnersDir`. No user-facing environment variable or CLI flag is added.

### 5. `hsq --help` lists plugin commands (amends ADR 0070 section 6)

Because bundled features (`jobs`, and later `automations`, `artifacts`, `webhooks`) register
their CLI commands through `SquawkPluginApi`, keeping `hsq --help` cold would hide bundled
feature commands from help output.

- `cliNeedsRuntime` returns `true` for `--help` and `-h` so `hsq --help` runs `bootRuntime()` and
  lists all registered commands: core commands, bundled feature commands (`hsq job`), and host
  plugin commands.
- Broken host plugins are already caught and skipped with a stderr warning, so they never break
  `hsq --help`. When home cannot be resolved during `--help`, host plugin discovery degrades
  quietly without preparing or creating home, printing core and bundled commands cleanly.
- `hsq --version`, `-v`, and remaining cold built-in subcommands (`artifact`, `message`,
  `webhook`, `automation`, `backup --help`, `remote-settings --help`, `worker
  list|inspect|collect|wait`) stay cold (`bootColdCli()`).
- `job` leaves `src/built-in-cli-commands.ts` and registers solely through
  `src/features/jobs/index.ts`. Running `hsq job` triggers runtime boot, works when `jobs/` is
  present, and returns `unknown command: job` when `jobs/` is absent.

### 6. Reporting in `hsq plugins` and `GET /api/v1/health`

- Bundled features report `source: 'bundled'` in `PluginLoadReport`, `hsq plugins`, and
  `GET /api/v1/health`, keeping `PluginSource` unchanged (`'bundled' | 'host'`).
- `PluginContributions` adds `launchParts: string[]` (in registration order), and `hsq plugins`
  renders `    launch parts: <ids>` alongside `commands` and `removal slots`.

## Architecture details

### Launch slot wiring (`src/core/launch-registry.ts`)

`core/launch-registry.ts` uses `createKeyedRegistry<string, LaunchPartDefinition>` from
`core/registry.ts` and exports `registerLaunchPart`, `checkLaunchPartRegistration`,
`sealLaunchParts`, `launchPartsSealed`, `registeredLaunchParts`, and `resolveLaunchParts`.
`boot.ts` is the sole production module that seals it (enforced by `src/boot.test.ts`).

`launchPreamble` (`src/workflows/run/session-events.ts`) awaits `resolveLaunchParts` before its
`launchStale` cancellation check, passing `{ runId, dataDir, repoRoot, home, cockpit, env:
profileEnv }`. Both `startStepSession` (`step-session.ts`) and `startContinuationSession`
(`continuation-session.ts`) merge `{ ...profile.env, ...launchParts.env, ...delegation?.env,
...ciTools?.env }` and pass `launchParts.prompts` into `launchSystemTail`.

Until later step-5 epics move `automations`, `artifacts`, and `webhooks` into `src/features/`,
`src/built-in-launch-parts.ts` (placed in the `shell` layer of `src/lint/layers.json`) registers
them at boot (plus `jobs` temporarily in S1 until S3 moves it into `src/features/jobs/index.ts`).

Core testkits (`src/core-registries.testkit.ts`) seal an empty launch-parts registry so core
tests do not pull feature modules into their Squeal selection closure (roadmap rule 5). Tests
that exercise shipped launch prompts (`workflows/launch-system-prompt.test.ts`,
`workflows/system-prompt.test.ts`) register the built-in launch parts explicitly.

### Scratch hold via `DeletionGate` and core process helpers

1. **Core process ownership (`src/core/process-ownership.ts`):** `processPredatesCurrentBoot`
   (from `src/delegation/process-liveness.ts`) and `groupOwned` (from `src/worker-scope/groups.ts`)
   hold no worker state and depend only on `core/process-stat.ts` and `core/session-process.ts`.
   Moving them to `src/core/process-ownership.ts` lets `src/features/jobs/job.ts` import core
   only, with zero worker imports.
2. **Deletion gate extensions (`src/runs/removal-slots.ts`):**
   - `DeletionGate.refuse(runId, kind, dataDir, context?: DeletionGateContext)` accepts optional
     `{ readonly finishedAt?: string | undefined; readonly archived?: boolean | undefined }`.
     `reapTerminalScratch` (`src/workflows/run/run-settlement.ts`) removes `jobHoldsScratch` and
     passes `{ finishedAt: run.finishedAt, archived: run.archived }` to `deletionRefusal(runId,
     'scratch', dataDir, context)`. `jobsDeletionGate` owns the `.hsq-job-kept` mark when
     `context` is provided and checks live jobs only when omitted (`sweepAgentTmpDirs`,
     `WorkerScratchCleanup.probe`, `archive-tmp`).
   - `DeletionGate.refuseDirectory?(dir: string, kind: 'scratch'): string | undefined` and
     `directoryDeletionRefusal(dir, kind)` let `sweepAgentTmpDirs` check un-keyed orphan/fallback
     directories through the registered deletion gates, eliminating the `dir => jobRunsIn([dir])`
     callback in `src/delegation/scratch-cleanup.ts`.

## Evidence

Measured on `main` at `a1bfe21d2` (2026-11-26):

- `src/lint/layer-import.baseline.json`: **83 entries** (53 `feature:workers`, 30 others).
  - 4 entries in `workflows/run/launch-context.ts` for `artifacts/lifecycle.ts`,
    `automations/enabled.ts`, `automations/prompts.ts`, `webhooks/prompt.ts` (plus 2
    `feature:workers` type-only entries kept per Out of scope).
  - 2 entries in `workflows/run/session-events.ts` for `artifacts/lifecycle.ts`, `jobs/command.ts`.
  - 1 entry in `workflows/run/run-settlement.ts` for `jobs/job.ts`.
  - Removing these 7 entries reduces the baseline from **83 -> 76**.
- Non-core files importing `src/jobs/`:
  - `src/built-in-cli-commands.ts` (`./jobs/cli.ts`)
  - `src/built-in-run-slots.ts` (`./jobs/removal-slot.ts`)
  - `src/delegation/scratch-cleanup.ts` (`../jobs/job.ts`, lines 49 and 124)
- What `src/jobs/` imports outside core:
  - `src/delegation/process-liveness.ts` (`processPredatesCurrentBoot`)
  - `src/worker-scope/groups.ts` (`groupOwned`)
- Baseline Squeal selection count (roadmap rule 5) on `a1bfe21d2`:
  - `packages/cezar/src/core/registry.ts`: **1,187 test files** (`complete: true`).

## Case tables

No run state, lock/ownership, tool-grant, worktree-write, or detached-process contract changes:
the job supervisor and claim transaction move intact from `src/jobs/` to `src/features/jobs/`.
The boot and launch cases below pin every new boundary condition at shipped defaults.

### Boot and launch cases

| Case | Boot / launch path | Behavior at shipped defaults |
| --- | --- | --- |
| Default install (`features/jobs/` present) | `bootRuntime()` | Loads 6 bundled runners, loads `jobs` (`source: 'bundled'`), loads host plugins, seals all 9 registries; `hsq plugins` lists `jobs` with `commands: job`, `removal slots: 1`, `launch parts: jobs`; launch prompt and env match baseline bytes |
| `features/` folder absent or empty (`jobs` absent) | `bootRuntime({ bundledFeaturesDir })` | Boot succeeds with zero feature load errors; `hsq plugins` omits `jobs`; `hsq job` exits 1 with `unknown command: job`; a task completes with no `## Long commands` / `job start` text in its system prompt |
| Present bundled feature folder throws on import or setup | `bootRuntime()` | Throws an error naming the bundled feature id and stops boot; registries remain unsealed |
| Host plugin registers a launch part (no `order`) | `bootRuntime({ pluginsDir })` | Defaults to `order: 100`; runs after built-in launch parts (10-40) and before the core handoff contract; env entries fold into session env |
| Launch-part `contribute()` throws or rejects | `resolveLaunchParts()` in `launchPreamble` | Catches error, logs one warning naming the part `id`, skips that part, and continues launching with all other parts intact |
| Unsealed launch registry read | `resolveLaunchParts()` / `registeredLaunchParts()` | Throws unsealed error naming `boot.ts` / testkit hint (fail closed) |
| `hsq --help` with resolved home | `cli-dispatch.ts` | Runs `bootRuntime()` and prints core, bundled feature (`hsq job`), and host plugin commands |
| `hsq --help` with unresolvable home | `cli-dispatch.ts` | Runs `bootRuntime()` without host plugins (quiet degradation, no home creation) and prints core and bundled feature commands |
| `hsq --version` or cold built-in (`hsq message`, `hsq artifact --help`) | `cli-dispatch.ts` | Runs `bootColdCli()`; loads zero runner, feature, or host plugin modules |

## Plan

Four child issues execute after S0 lands on `main`:

| Slice | Issue | Scope | Depends on | Baseline |
| --- | --- | --- | --- | --- |
| S0 | hearsay-tools/squawk#4309 | Spec, plan, and child issues S1-S4 | — | 83 |
| S1 | hearsay-tools/squawk#4312 | Launch slot in `plugin/api.ts` and `core/launch-registry.ts`; migrate four features | S0 | 83 -> 77 |
| S2 | hearsay-tools/squawk#4313 | Bundled feature loader (`plugin/bundled-features.ts`) and `hsq --help` runtime boot | S0 | 77 (or 83) |
| S3 | hearsay-tools/squawk#4314 | Move `jobs` to `features/jobs/`, deletion-gate scratch hold, core process helpers, `cez/bundled-feature-import` | S1, S2 | 77 -> 76 |
| S4 | hearsay-tools/squawk#4315 | Absent-jobs test, live runner job acceptance, ADR 0072 + ADR 0070 amendment, roadmap counts, close-out | S3 | 76 |
