# Open registries and small tables: plan
Status: active

The plan for [the spec](2026-11-23-open-registries-and-tables.md), epic
hearsay-tools/squawk#4152. Baseline: `main` at `b4c0510be`. Each slice is one pull request into
`main` and one child issue. Check a slice against current `main` before it starts.

## Rules for every slice

- `main` stays usable after each slice at shipped defaults.
- Follow ADR 0065 rules: built-in features register through the exact same API as outside plugins;
  zero config stays; no public API stability promise yet.
- Slices running in parallel must not edit overlapping hunks or violate semantic prerequisites;
  shared boot files (`subcommands.ts`, `built-in-*.ts`) pass the coordinator patch-release check.
- Follow `docs/areas/packages.md` ("Moving a source file") before moving any module.
- Each slice that moves a feature behind registration records Squeal selection counts before and
  after in its PR body (roadmap rule 5), noting if `selection.reason` is `unsynced`.
- Preserve cold-CLI lazy loading (`packages/cezar/src/index-runners.test.ts` and
  `index-run-slots.test.ts`).
- Keep `AGENTS.md` citation discipline: always use repository-qualified references
  (`hearsay-tools/squawk#N`), never bare `#N`.

## Order and waves

| Wave | Slices | Starts after | Phase exit on integrated `main` |
| --- | --- | --- | --- |
| 0 | Spec & plan PR | — | Spec, plan, roadmap link, and 10 child issues live on `main` |
| 1 | S0a, B1 (parallel) | Wave 0 merged | `core/registry.ts` + removal/worker-execution registries sealed; contract & cockpit open plugin wait green |
| 2 | S0b (isolated) | S0a merged | `runner-registry.ts` uses register-then-seal; all runner tests use `sealTestRunners` or `vi.resetModules()`; CI green |
| 3 | A1, B2, C1, D1 (up to 4 parallel) | S0a merged (B2 also after B1) | All 4 new registries live, sealed at boot, and passing unit/parity/cold-CLI tests |
| 4 | A2, B3 (parallel) | A1 (for A2), B2 (for B3) | All 7 required `layer-import.baseline.json` entries removed; fixture tests for tool & wait pass |
| 5 | E1 | S0b, A2, B3, C1, D1 merged | Lint rules read data tables; ADR 0069 merged; spec `Status: done`; `-plan.md` deleted; roadmap updated |

## S0a. Core registry helper, removal slots, and worker executions

Issue: hearsay-tools/squawk#4154.

- Add `packages/cezar/src/core/registry.ts` exporting `createKeyedRegistry`, `createListRegistry`,
  and `createSingleRegistry` with `register`, `seal`, `isSealed`, fail-closed reads, same-reference
  idempotency, conflict/reserved-key errors, and post-seal write errors.
- Add `packages/cezar/src/core/registry.test.ts` covering every row of the spec's
  [Registry lifecycle cases](2026-11-23-open-registries-and-tables.md#registry-lifecycle-cases).
- Migrate `runs/removal-slots.ts` onto `createListRegistry` (three lists sharing one seal gate)
  and `runs/worker-executions-registry.ts` onto `createSingleRegistry`.
- Split registration from sealing in `built-in-run-slots.ts` (`registerBuiltInRunSlots()` registers;
  boot boundary seals `sealRunSlots()` and `sealWorkerExecutions()`, keeping `registerBuiltInRunSlots`
  or adding explicit `sealBuiltInRunSlots` as cleanly required by `run-slot-entries.test.ts`).
- Verify `removal-slots.test.ts`, `removal-slots-unsealed.test.ts`, `index-run-slots.test.ts`,
  `run-slot-entries.test.ts`, and `delegation/family-end-unsealed.test.ts`.

## S0b. Migrate runner registry to register-then-seal

Issue: hearsay-tools/squawk#4155.

- Migrate `core/runner-registry.ts` onto `createKeyedRegistry` with `LEGACY_RUNNER_IDS` as
  reserved keys. Export `sealRunners()` and `runnersSealed()`.
- Switch passive cold reads (`runs/legacy-run-rows.ts`, `knownRunnerIds()`, `savedRunnerId()`,
  `savedRunnerRegistration()`) to check `isSealed()` instead of `registry.size === 0`.
- Update `prepareCommandRuntime` and any production entry points that call `registerBuiltInRunners()`
  to seal the runner registry after registration.
- Add `sealTestRunners(...)` helper in a shared testkit (`core/runner-registry.testkit.ts` or
  existing runner testkit) and migrate the direct `registerRunner(` test files; keep
  `vi.resetModules()` for tests that register dynamically mid-test. No production unseal/reset API.
- Add unsealed-read, post-seal-write, conflict, and legacy-key unit tests.

## A1. Core agent tool registry and IPC dispatch

Issue: hearsay-tools/squawk#4156.

- Add `ci-wait/tool-registry.ts` using `createKeyedRegistry` from `core/registry.ts`.
- Define `AgentToolDefinition` (metadata, schema/lazy schema, trigger, label, `enabled(env)`,
  `envNames(env)`, body limit, timeout, validation, refusal/hint formatting, session handler).
- Register the four core tools (`cezar_wait`, `cezar_ask`, `cezar_cancel_wait`, `cezar_done`) in
  core; keep temporary registration of preview and automation tools from shell boot until A2 moves
  their source modules.
- Update `ci-wait/controller.ts` to expose `GET /api/v1/tools` (enabled tool definitions +
  instructions for the capability's session) and `POST /api/v1/tools/:name` (generic auth, body
  limit, enablement, validation, and handler dispatch).
- Update `ci-wait/client.ts`, `ci-wait/tools.ts`, `ci-wait/tool-names.ts`, `ci-wait/mcp.ts`,
  `scripts/pi-ci-wait.mjs`, and `scripts/omp-ci-wait.mjs` to consume the registry / controller IPC
  catalog (retaining direct in-process registry fallback in `createCiMcpServer()` when no IPC
  socket is configured).
- Register and seal built-in tools at the runtime boot boundary (`prepareCommandRuntime` and
  testkits that start sessions/controllers).

## A2. Move preview and automation tools to their features

Issue: hearsay-tools/squawk#4157.

- Move preview tool definitions, env enablement (`previewToolEnabled`), refusal/input helpers, and
  session handler wiring out of `ci-wait/*` and `workflows/run/squawk-tools.ts` into `preview/`.
- Move automation/schedule tool definitions, env enablement (`automationsToolEnabled`), refusal/input
  helpers, and session handler wiring out of `ci-wait/*` into `automations/`.
- Register preview and automation tools at the shell boot boundary (`built-in-tools.ts`), keeping
  identical tool order, schemas, hints, and error codes.
- Remove `preview/registration.ts` entries from `ci-wait/client.ts`, `ci-wait/controller.ts`, and
  `workflows/run/squawk-tools.ts`, and remove `automations/enabled.ts` from `ci-wait/tool-env.ts`
  in `packages/cezar/src/lint/layer-import.baseline.json` (and remove `ci-wait/resource-pool.ts`
  from `workflows/run/squawk-tools.ts` if cleanly decoupled).
- Add a fixture-tool test that registers a custom agent tool, advertises it through
  `GET /api/v1/tools` / `mcp.ts`, invokes it via `POST /api/v1/tools/:name`, and receives its
  result without editing any core file.
- Record Squeal selection counts before and after in the PR body.

## B1. Contract open plugin wait member and cockpit fallbacks

Issue: hearsay-tools/squawk#4158.

- In `packages/contract/src/waits.ts`, add `pluginWaitEntrySchema` (`kind: 'plugin'`, `pluginKind`,
  `via: z.string().min(1).max(64)`, `deadline?`, `summary`, `payload`, `result?`) to `waitSchema`,
  add a `kind: 'plugin'` member to `openWaitSchema` and `waitingOnSchema`, and keep all seven
  built-in arms strict.
- In `packages/contract/src/wait-tools.ts`, allow custom wait kinds in `squawkWaitRequestSchema`
  and `squawkWaitAnswerSchema` (built-in arms stay strict).
- In `packages/contract/src/waiting-on.ts`, rank open `plugin` waits after `process` and before
  `timer` (earliest deadline wins among multiple plugin waits).
- In `packages/contract/src/attention.ts`, map `waitingOn.kind === 'plugin'` to `monitoring` with
  `label: waitingOn.summary` and webhook state `'waiting-other'`.
- In `packages/contract/src/activity.ts` and `packages/cezar/src/activity/wait.ts`, add
  `kind: 'plugin'` to `activityWaitSchema` and project `pluginKind` + `summary`.
- In `packages/web/src/routes/task-thread/run-waits.tsx`, `packages/web/src/lib/run-row-meta.ts`,
  and `packages/web/src/routes/activity/now-box.ts`, render open plugin waits generically using
  `summary` and optional `deadline`.
- Add contract and cockpit unit tests covering every row of the spec's
  [Open plugin wait cases](2026-11-23-open-registries-and-tables.md#open-plugin-wait-cases).

## B2. Core wait-kind registry and lazy `cezar_wait` schema

Issue: hearsay-tools/squawk#4159.

- Add `workflows/run/wait-kind-registry.ts` using `createKeyedRegistry` from `core/registry.ts`.
- Define the extensible `WaitKindRegistration` contract covering wait metadata, request schema
  metadata for `cezar_wait`, duplicate/canonicalize rules, registration handler, watch lifecycle
  (`arm`/`disarm`/`dispose`), resolution/formatting, and charging/cancellability rules.
- Register the three core wait kinds (`human`, `timer`, `process`) in core; temporarily register
  the remaining built-in kinds (`pr`, `worker`, `peer`, `subagent`) through the same API from
  shell boot until B3 moves them to their owning features.
- Refactor `wait-kinds.ts`, `wait-engine.ts`, and `wait-registry.ts` to read the sealed registry.
- Change `flatWaitInputSchema()` in `ci-wait/tool-catalog.ts` (or core wait tool definition) to
  build lazily after the wait-kind registry is sealed instead of at module import time.
- Seal built-in wait kinds at boot and in wait/run-manager testkits; verify all wait parity suites.

## B3. Move feature and runner wait kinds onto the wait-kind registry

Issue: hearsay-tools/squawk#4160.

- Move `pr` wait-kind row, registration, and watch adapter into `feature:forge` (`ci-wait/`).
- Move `worker` and `peer` wait-kind rows, registration, and watch/reconcile hooks into
  `feature:workers` (`delegation/`).
- Register `subagent` through the same wait-kind registry.
- Remove the hardcoded `watches` map and the `if (WAIT_KINDS[wait.kind].watch !== 'worker')`
  branch in `workflows/run/wait-engine.ts`.
- Remove `ci-wait/supervisor.ts` entries from `wait-engine.ts`, `wait-kinds.ts`, and
  `wait-registry.ts` in `packages/cezar/src/lint/layer-import.baseline.json` (and `delegation/policy.ts`
  from `wait-registry.ts` if cleanly decoupled).
- Add a fixture-wait test that registers a custom plugin wait kind, opens it through `cezar_wait`,
  watches and resolves it through `WaitEngine`, and verifies contract `computeWaitingOn` /
  `deriveAttention` output without editing any core file.
- Record Squeal selection counts before and after in the PR body.

## C1. Open workflow step kinds

Issue: hearsay-tools/squawk#4161.

- Update `packages/contract/src/workflows.ts` to support `{ id, name?, kind: 'plugin', pluginKind,
  config?, onFail? }` alongside unchanged `agent` and `check` syntax, and skip plugin steps in
  `providersRequiredByWorkflow`.
- Update `packages/contract/src/run-status.ts` (`stepKindSchema = z.enum(['agent', 'check', 'plugin'])`),
  `packages/contract/src/runs.ts` (optional `pluginKind` on `StepState`), and
  `packages/web/src/routes/task-thread/step-rail.tsx` (render `step.pluginKind ?? step.kind`).
- Add `workflows/step-kind-registry.ts` using `createKeyedRegistry` from `core/registry.ts`, and
  register `'agent'` and `'check'` step kinds in core.
- Update `workflows/types.ts`, `workflows/load.ts` (validate registered plugin step kinds on load
  when sealed), and `workflows/run/step-loop.ts` to dispatch step execution through the sealed
  step-kind registry.
- Add a fixture-step test that registers a custom plugin step kind, loads a workflow YAML using
  it, executes it through `StepLoop`, and verifies step state and retry behavior without editing
  core files.

## D1. Lazy CLI command registry

Issue: hearsay-tools/squawk#4162.

- Add `packages/cezar/src/core/cli-registry.ts` using `createKeyedRegistry` from `core/registry.ts`.
- Add `packages/cezar/src/built-in-cli-commands.ts` (`shell`) registering all 20 built-in commands
  (`serve`, `run`, `init`, `projects`, `server-install`, `server-deploy`, `server-uninstall`,
  `backup`, `discover`, `artifact`, `job`, `task`, `automation`, `webhook`, `worker`, `message`,
  `remote-settings`, `migrate`, `server-migrate`, `migrate-project`) with lazy `load()`, usage
  lines, `homeMode`, and `runtimeMode`.
- Replace `loadSubcommand` switch in `subcommands.ts`, command switch and static `cliHelp()` in
  `cli-dispatch.ts`, and hardcoded `entries`/`unconditional` command arrays in `home/entry.ts`
  with reads from the sealed CLI command registry.
- Ensure cold commands (`--help`, `--version`, `job`, `artifact`, `worker list`, `backup --help`,
  `remote-settings --help`) seal only the CLI registry and never load runner or store modules
  (`index-runners.test.ts` and `index-run-slots.test.ts` stay green).
- Add a fixture-command test that registers a custom CLI command, checks `--help` output, and
  dispatches it without editing core files.

## E1. Data-driven lint rules, docs, ADR, and spec close-out

Issue: hearsay-tools/squawk#4163.

- Add plain data modules (zero engine/runner imports) for built-in wait kinds, legacy wait kinds,
  built-in wait `via` values, and built-in step kinds.
- Update `packages/cezar/src/lint/owner-reader-rules.ts` (`WAIT_KIND_LITERALS`) and
  `packages/cezar/src/lint/test-enum-literal.ts` (`TEST_ENUM_VALUES.kind`, `TEST_ENUM_VALUES.via`)
  to read from those data modules.
- Write `docs/adr/0069-adopt-register-then-seal-registries-for-extension-tables.md`.
- Update relevant area docs (`docs/areas/cli.md`, `docs/areas/workflows.md`, `docs/areas/http-api.md`
  as touched) and `.ai/specs/2026-11-18-plugin-core-roadmap.md` (mark step 3 Done with links to
  spec and ADR 0069).
- Complete the Implementation record and final measurements in
  `.ai/specs/2026-11-23-open-registries-and-tables.md`, mark it `Status: done`, delete this
  `-plan.md` file, and fix all links to it.
