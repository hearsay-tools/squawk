# Add a launch slot and load bundled feature plugins

Approved design: [launch slot and bundled jobs feature plugin](../../.ai/specs/2026-11-26-launch-slot-and-bundled-jobs.md),
including the owner's six decisions of 2026-11-26 (task `62289188`). Epic
hearsay-tools/squawk#4309, first version of step 5 of the
[plugin core roadmap](../../.ai/specs/2026-11-18-plugin-core-roadmap.md). Builds on
[ADR 0065](0065-define-the-core-by-a-layer-map.md),
[ADR 0068](0068-publish-a-run-lifecycle-and-reach-the-run-store-through-ports.md),
[ADR 0069](0069-adopt-register-then-seal-registries-for-extension-tables.md),
[ADR 0070](0070-load-host-folder-plugins-and-export-the-runner-kit.md) (amending section 6), and
[ADR 0071](0071-keep-runner-folders-self-contained.md).

## Decision

Squawk opens a public launch slot on `SquawkPluginApi`, loads bundled feature folders through the
same plugin loader as bundled runners and host plugins, and moves `jobs` into
`packages/cezar/src/features/jobs/` as the first bundled feature plugin with zero outside non-test
imports. Paths below are under `packages/cezar/` unless noted.

### 1. One public launch slot (`src/core/launch-registry.ts`)

- `SquawkPluginApi` adds `registerLaunchPart(part: LaunchPartDefinition): void`. Built-in
  features, bundled features, and host plugins in `<config>/plugins/` use the same public API with
  no internal back door (ADR 0065 rule 1). The API remains unstable until Squawk installs plugin
  packages from npm or git (ADR 0070 section 7).
- `src/core/launch-registry.ts` is the ninth process-wide register-then-seal registry
  (`core/registry.ts`), sealed only at the boot boundary (`src/boot.ts`) in production.
- Each launch part provides a unique non-empty `id`, an optional finite numeric `order` (default
  `100`, lower runs first, ties keep registration order), and a sync or async
  `contribute(context: LaunchPartContext)` returning `{ env?, prompt? }` or `undefined`. Core knows
  no feature names.
- Built-in features register with orders `10` (`automations`), `20` (`webhooks`), `30`
  (`artifacts`), and `40` (`jobs`), preserving the default install's system prompt byte-for-byte.
- `resolveLaunchParts` runs parts sequentially in resolved order, folding returned `env` entries
  into a frozen snapshot passed to later parts. If any part throws or rejects, it catches the
  error, logs one warning naming the part `id`, and skips that part so the launch continues. Core
  env preflight errors (`AgentTempDirError`) stay in core `agentEnv` and still fail launch loudly.
- Both `StepSession` (`src/workflows/run/step-session.ts`) and `ContinuationSession`
  (`src/workflows/run/continuation-session.ts`) share `launchSessionEnvironment` in
  `src/workflows/run/session-events.ts`, merging `{ ...profile.env, ...launchParts.env,
  ...delegation?.env, ...ciTools?.env }` and deriving `additionalDirectories` from that merged env.
- `@hearsay-tools/squawk/plugin` (`src/plugin/index.ts`) exports `LaunchPartDefinition`,
  `LaunchPartContext`, `LaunchPartContribution`, `LaunchCockpitAddress`, and
  `DeletionGateContext`. `PluginContributions` adds `launchParts: string[]`, rendered as
  `launch parts: <ids>` in `hsq plugins`.

### 2. Bundled feature folder discovery and boot order

- Bundled features live under `src/features/<id>/index.ts` (built to
  `dist/features/<id>/index.js`). `src/plugin/bundled-features.ts` discovers immediate child
  directories with an entry file (`index.mjs`, `index.js`, `index.ts`) in locale-independent ASCII
  code-point order.
- `bootRuntime()` (`src/boot.ts`) registers built-ins, loads bundled runners, loads bundled
  features (`loadBundledFeatures`, sharing `loadBundledEntries` with `loadBundledRunners`), loads
  host plugins in `<config>/plugins/`, runs `beforeSeal`, and seals all nine registries.
- An absent or empty `features/` folder (or a missing `features/jobs/` folder) succeeds and is not
  advertised in `pluginLoadReport().folders`. A present bundled feature folder that fails to
  import, register, or commit throws `Bundled feature "<id>" failed to load: ...` and stops boot
  without sealing registries, retaining the failure on retry.
- Loaded bundled features report `source: 'bundled'` in `PluginLoadReport`, `hsq plugins`, and
  `GET /api/v1/health`.
- `BootRuntimeOptions` accepts a test-only `bundledFeaturesDir?: string` override parallel to
  `bundledRunnersDir`. No user-facing env var or CLI flag is added. `check:pack` (`src/pack-check.ts`,
  `scripts/check-pack.mjs`) verifies every shipped `dist/features/<id>/index.js` is packed.

### 3. `hsq --help` loads commands (amends ADR 0070 section 6)

- Because bundled features register their CLI commands through `SquawkPluginApi`, top-level help
  (`--help`, `-h`, `--repo <dir> --help`, `run --help`) now runs `bootRuntime()` so core, bundled
  feature (`hsq job`), and host plugin commands appear in help output.
- Broken host plugins are skipped with a stderr warning as before; when home cannot be resolved
  during help, host discovery degrades quietly without preparing or creating home.
- `--version`, `-v`, and remaining cold built-in commands stay on `bootColdCli()`.
- `job` leaves `src/built-in-cli-commands.ts` and registers solely through
  `src/features/jobs/index.ts`; when `jobs` is absent, `hsq job` exits 1 with
  `unknown command: job`.
- [ADR 0070 section 6](0070-load-host-folder-plugins-and-export-the-runner-kit.md#6-help-loads-commands-version-and-cold-commands-stay-cold)
  records the amended rule text.

### 4. Jobs as the first bundled feature plugin and `cez/bundled-feature-import`

- `src/jobs/*` moves to `src/features/jobs/*`. `src/features/jobs/index.ts` registers `job`
  (CLI command), `jobsDeletionGate` (removal slot), and `jobs` (launch part, `order: 40`) solely
  through `SquawkPluginApi`.
- Shared process-ownership proofs (`processPredatesCurrentBoot`, `groupOwned`) move to
  `src/core/process-ownership.ts` (core dependencies only) so `features/jobs/job.ts` imports no
  worker module.
- `DeletionGate` (`src/runs/removal-slots.ts`) accepts optional `context?: DeletionGateContext`
  (`{ finishedAt?, archived? }`) on `refuse(...)` and optional `refuseDirectory?(dir, 'scratch')`
  (queried via `directoryDeletionRefusal`). `jobsDeletionGate` owns `.hsq-job-kept` and orphan
  directory checks, removing all `jobs` imports from `workflows/run/run-settlement.ts`,
  `delegation/scratch-cleanup.ts`, and `runs/agent-tmpdir.ts`.
- `cezar_wait` tool metadata (`src/ci-wait/tool-catalog.ts`,
  `src/workflows/run/wait-input-descriptors.ts`) gates `hsq job` wording on
  `cliCommandAdvertised('job')` (`!cliCommandsSealed() || hasCliCommand('job')`): default boots
  keep exact existing bytes, and absent-jobs boots advertise generic `process` wait guidance with
  zero import of `features/jobs/`.
- `cez/bundled-feature-import` (`src/lint/bundled-feature-import.ts`, zero baseline entries)
  forbids any non-test source file outside `packages/cezar/src/features/<id>/` (including another
  feature folder) from importing a file inside it via ESM/TS import, `export ... from`, dynamic
  `import()`, `import('...')` type, `import x = require('...')`, or literal `require('...')`.

## Consequences

- **Core shrinks by 7 baseline entries.** `src/lint/layer-import.baseline.json` drops from 83 to
  76 entries (6 via the launch slot in `launch-context.ts` and `session-events.ts`, 1 via the jobs
  move in `run-settlement.ts`). Neither `launch-context.ts` nor `session-events.ts` imports any
  non-worker feature module.
- **Strict feature isolation.** Any non-test source file outside `src/features/jobs/` that tries
  to import into `src/features/jobs/` fails `npm run lint` immediately with no baseline escape
  hatch.
- **Proven absent and present behavior.** Automated acceptance proves Squawk boots cleanly and
  completes tasks with `features/` empty (no `jobs` in `hsq plugins`, `hsq job` rejected, no job
  text in launch prompt or `cezar_wait` metadata). Live acceptance on a real runner CLI proves a
  task with `jobs` loaded starts a job via `hsq job start` that outlives the agent session.
- **Slight startup cost for `hsq --help` and `hsq job`.** Both now run `bootRuntime()` instead of
  the cold CLI path. Version and remaining cold built-in commands stay cold.
- **Deferred work.** Moving features with HTTP routes or server lifecycle (`automations`,
  `artifacts`, `webhooks`, `preview`, `forge`, `activity`) waits for the next step-5 epic (HTTP
  route and server start/stop slots). Copying a bundled feature folder outside the product waits
  for a feature kit.

## Considered Options

- **Keep an internal registration helper for built-in launch parts.** Rejected. Violates ADR 0065
  rule 1; exposing `registerLaunchPart` on `SquawkPluginApi` lets bundled features and host
  plugins share one contract.
- **Order launch parts by a core list of feature ids.** Rejected. Reintroduces feature names into
  core; feature-neutral numeric `order` preserves exact prompt order while letting host plugins
  default to `100`.
- **Fail the whole launch when a launch part throws.** Rejected. Against zero-config degradation;
  catching, warning with the part `id`, and skipping keeps tasks launchable while core preflight
  errors (`AgentTempDirError`) still fail loudly.
- **Keep `hsq --help` cold and list only core commands.** Rejected (amends ADR 0070 section 6).
  Bundled features register commands through the plugin API, so cold help would hide `hsq job` and
  future feature commands from users.
