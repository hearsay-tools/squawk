# Launch slot and bundled jobs feature plugin — implementation plan
Status: active

Working plan for epic hearsay-tools/squawk#4309 and spec
[2026-11-26-launch-slot-and-bundled-jobs.md](2026-11-26-launch-slot-and-bundled-jobs.md). Delete
this `-plan.md` file in Slice S4 once the epic closes, per
[TEMPLATE.md](TEMPLATE.md).

## Slice schedule

| Wave | Slices | Issues | Parallelism |
| --- | --- | --- | --- |
| Wave 0 | S0 | hearsay-tools/squawk#4309 | Spec, plan, child issues; lands first on `main` |
| Wave 1 | S1, S2 | hearsay-tools/squawk#4312, hearsay-tools/squawk#4313 | Disjoint code areas except minor coordination in `boot.ts` and `plugin/cli.ts`; run in parallel workers and resolve any small merge cleanly |
| Wave 2 | S3 | hearsay-tools/squawk#4314 | Starts after S1 and S2 land on `main` |
| Wave 3 | S4 | hearsay-tools/squawk#4315 | Starts after S3 lands on `main`; acceptance, ADR 0072, roadmap, close-out |

## Structural checks

Run on integrated `main` after each wave:

1. `node -e "const d=JSON.parse(require('fs').readFileSync('packages/cezar/src/lint/layer-import.baseline.json','utf8')); console.log(d.entries.length)"`
   - Wave 1 exit: <= 77 entries.
   - Wave 2 & 3 exit: <= 76 entries.
2. `npm run lint` (includes `cez/layer-import`, `cez/bundled-feature-import` from Wave 2 onward, and all baseline checks).
3. `node .github/scripts/check-citations.cjs`.
4. `packages/cezar/src/boot.test.ts` confirms only `boot.ts` and registry definition modules call `seal*`.

## Slice details

### S1 — Launch slot (hearsay-tools/squawk#4312)

- Add `packages/cezar/src/core/launch-registry.ts` using `createKeyedRegistry` from
  `core/registry.ts`.
  - Exports `LaunchCockpitAddress`, `LaunchPartContext`, `LaunchPartContribution`,
    `LaunchPartDefinition`, `registerLaunchPart`, `checkLaunchPartRegistration`,
    `sealLaunchParts`, `launchPartsSealed`, `registeredLaunchParts`, `resolveLaunchParts`.
  - Validates non-empty string `id`, finite numeric `order` when provided (default `100`), and
    function `contribute`.
  - `resolveLaunchParts(context, warn)` sorts by `(order ?? 100)` preserving registration order on
    ties, runs each `contribute` sequentially with cumulative `env`, catches errors and calls
    `warn` naming `part.id`, and returns `{ env, prompts }`.
- Wire `registerLaunchPart` into `packages/cezar/src/plugin/api.ts` (staging, duplicate check,
  shape check, commit, `PluginContributions.launchParts`), export types in
  `packages/cezar/src/plugin/index.ts`, and render `launch parts` in
  `packages/cezar/src/plugin/cli.ts`.
- Add `packages/cezar/src/built-in-launch-parts.ts` (in `shell` layer of `lint/layers.json`)
  registering `automations` (`10`), `webhooks` (`20`), `artifacts` (`30`), and `jobs` (`40`).
- Seal launch parts in `packages/cezar/src/boot.ts`; seal empty launch parts in
  `packages/cezar/src/core-registries.testkit.ts` so core tests stay decoupled; add a testkit
  helper for tests that need built-in launch parts.
- Update `workflows/run/{launch-context,session-events,compose,step-session,continuation-session,types}.ts`
  so `launchPreamble` resolves launch parts once per launch, folds `launchParts.env` into session
  env, and passes `launchParts.prompts` into `launchSystemTail`.
- Remove the 6 feature imports from `launch-context.ts` and `session-events.ts` and remove their
  6 entries from `packages/cezar/src/lint/layer-import.baseline.json` (83 -> 77).
- Add unit tests in `core/launch-registry.test.ts` and extend `plugin/api.test.ts`,
  `plugin/cli.test.ts`, `boot.test.ts`, `workflows/launch-system-prompt.test.ts`, and
  `workflows/system-prompt.test.ts`.
- Record Squeal rule-5 selection counts for `core/registry.ts` and `core/launch-registry.ts`.

### S2 — Bundled feature loader and `--help` runtime boot (hearsay-tools/squawk#4313)

- Add `packages/cezar/src/plugin/bundled-features.ts` mirroring `bundled-runners.ts`:
  - `bundledFeaturesDir()` resolves `../features/` relative to `import.meta.url`.
  - `bundledFeatureFolders(dir)` scans child directories with `index.mjs`, `index.js`, or
    `index.ts` in ASCII code-point order; returns `[]` when `dir` is absent (`ENOENT`) or empty.
- Add `loadBundledFeatures(dir?: string)` in `packages/cezar/src/plugin/loader.ts`:
  - Returns cleanly when `bundledFeatureFolders(dir)` is empty.
  - Installs resolve hook when any feature is found, runs each via `loadEntry`, records each with
    `source: 'bundled'`, and throws `Bundled feature "<id>" failed to load: ...` on any failure.
- Add `bundledFeaturesDir?: string` to `BootRuntimeOptions` in `packages/cezar/src/boot.ts`; call
  `loadBundledFeatures` after `loadBundledRunners` and before `loadPluginFolder` (memoized across
  retries like `bundledRunnersLoad`).
- Update `packages/cezar/src/cli-dispatch.ts`:
  - `cliNeedsRuntime` returns `true` for `--help` / `-h` (and keeps `--version` / `-v` and cold
    built-in subcommands cold).
  - For `--help` / `-h`, pass a silent warning handler to `hostPluginsDir` so an unresolvable home
    degrades cleanly without emitting home errors or creating home directories.
- Update `packages/cezar/src/plugin/cli.ts` usage text and tests (`plugin/bundled-features.test.ts`,
  `plugin/loader.test.ts`, `boot.test.ts`, `cli-dispatch.test.ts`, `index-runners.test.ts`).

### S3 — Move jobs to `features/jobs/` and add `cez/bundled-feature-import` (hearsay-tools/squawk#4314)

- Create `packages/cezar/src/core/process-ownership.ts` holding `processPredatesCurrentBoot` and
  `groupOwned` (pure core dependencies only); update `delegation/process-liveness.ts`,
  `worker-scope/groups.ts`, and `autosave-cleanup.ts`.
- Extend `DeletionGate` in `packages/cezar/src/runs/removal-slots.ts` with optional
  `DeletionGateContext` (`{ finishedAt?: string; archived?: boolean }`) on `refuse(...)` and
  optional `refuseDirectory?(dir: string, kind: 'scratch')` + `directoryDeletionRefusal(dir, kind)`.
- Update `runs/agent-tmpdir.ts` (`sweepAgentTmpDirs` checks `directoryDeletionRefusal(dir, 'scratch')`),
  `workflows/run/run-settlement.ts` (remove `jobHoldsScratch` and `jobs/job.ts` import; pass
  `{ finishedAt: run.finishedAt, archived: run.archived }` to `deletionRefusal`), and
  `delegation/scratch-cleanup.ts` (remove `jobs/job.ts` import; use `deletionRefusal` in `probe`
  and drop the `spare` job callback in `recover`).
- Move `packages/cezar/src/jobs/*` to `packages/cezar/src/features/jobs/*`:
  - Fix `ownCommand()` relative path in `features/jobs/command.ts` (`../../index.ts` / `../../index.js`).
  - Move `.hsq-job-kept` hold logic into `features/jobs/removal-slot.ts` (`jobsDeletionGate`) and
    implement `refuseDirectory(dir, 'scratch')`.
  - Add `packages/cezar/src/features/jobs/index.ts` exporting default `setup(api)` registering
    CLI command `job`, removal slot `jobsDeletionGate`, and launch part `jobs` (`order: 40`).
- Remove `jobs` from `built-in-cli-commands.ts`, `built-in-run-slots.ts`, and
  `built-in-launch-parts.ts`.
- Update `lint/layers.json` (`"feature:jobs": ["features/jobs/"]`), remove `run-settlement.ts ->
  jobs/job.ts` from `lint/layer-import.baseline.json` (77 -> 76), and update
  `lint/test-unpinned-clock-date.baseline.json` path for moved `job.test.ts`.
- Add `packages/cezar/src/lint/bundled-feature-import.ts` (`cez/bundled-feature-import`, zero
  baseline entries) and `bundled-feature-import.test.ts`; wire into `lint/plugin.ts` and
  `.oxlintrc.json`.
- Update affected tests (`cli-dispatch.test.ts`, `index-runners.test.ts`, `cli-references.test.ts`,
  `runs/store.test.ts`, `workflows/agent-tmpdir.test.ts`, `workflows/run/guard-decisions.test.ts`,
  `workflows/run/scratch-removal-slots.test.ts`, `delegation/scratch-cleanup.test.ts`,
  `workflows/launch-system-prompt.test.ts`, `workflows/system-prompt.test.ts`).

### S4 — Acceptance, ADR 0072, roadmap, and epic close-out (hearsay-tools/squawk#4315)

- Add automated absent-jobs acceptance test booting with empty `bundledFeaturesDir`:
  - Verifies `hsq plugins` omits `jobs`, `hsq job` exits 1 as unknown command, a task runs to
    completion, and its composed system prompt names no `## Long commands` or `job start`.
- Run packaged `test/e2e/job-cli.test.ts` and a live acceptance run on a real runner CLI with
  jobs loaded where the task starts a job with `hsq job start` and the job outlives the agent
  session; record sanitized evidence in the spec.
- Write `docs/adr/0072-add-a-launch-slot-and-load-bundled-feature-plugins.md`, add the ADR 0070
  section 6 amendment note for `hsq --help`, and update `docs/plugins.md` and `docs/areas/cli.md`.
- Update `.ai/specs/2026-11-18-plugin-core-roadmap.md` with Squeal rule-5 counts and step 5
  first-epic completion, mark `.ai/specs/2026-11-26-launch-slot-and-bundled-jobs.md` `Status: done`,
  and delete this `-plan.md` file.
