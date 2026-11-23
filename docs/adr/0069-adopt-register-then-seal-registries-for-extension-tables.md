# Adopt register-then-seal registries for extension tables

Approved design: [open registries and small tables](../../.ai/specs/2026-11-23-open-registries-and-tables.md),
including the owner's six decisions of 2026-11-23 (tasks `caba5208` and `1bc159a9`). Epic
hearsay-tools/squawk#4152, step 3 of the
[plugin core roadmap](../../.ai/specs/2026-11-18-plugin-core-roadmap.md). It applies
[ADR 0065](0065-define-the-core-by-a-layer-map.md): built-in features and outside extensions
register through the same APIs, zero config stays, and no public stability promise starts until
step 4.

## Decision

All seven process-wide registries share one two-phase lifecycle in `core/registry.ts`
(**register, then seal, then read**), and four formerly closed extension tables — agent tools, wait
kinds, workflow step kinds, and CLI commands — open behind it. Paths are under `packages/cezar/src/`
unless noted.

### 1. Unified registry lifecycle (`core/registry.ts`)

`core/registry.ts` is a pure `core` module exporting `createKeyedRegistry`, `createListRegistry`,
and `createSingleRegistry`. Every process-wide registry follows the same rules:

- **Fail closed until sealed.** Every registry starts unsealed. Normal reads (`get`, `has`,
  `values`, `keys`, `entries`) throw an error naming both the registry and its boot call until
  `seal()` runs. Single-slot `get()` also throws when sealed with no registration.
- **Same-reference idempotency and strict conflict checks.** Re-registering the exact same object
  or function reference is a no-op before or after seal. Registering a different value under an
  existing key, a reserved legacy key, a second distinct single-slot value, or any new entry after
  `seal()` throws. `seal()` itself is idempotent.
- **Registration never seals.** `register*()` functions only register entries. The boot boundary
  (`index.ts` for CLI commands; `subcommands.ts` `prepareCommandRuntime` for runtime registries)
  calls `seal*()` after all registrations finish.
- **Per-registry sealing.** Each registry seals independently, so cold CLI commands seal only the
  CLI registry and unit tests seal only the registries they drive.
- **Passive cold reads.** Callers that read saved data or metadata without booting the runtime
  (`runs/legacy-run-rows.ts`, `knownRunnerIds()`, `savedRunnerId()`, `savedRunnerRegistration()`,
  `knownStepKinds()`, `knownCliCommand()`, `workerExecutionsRegistered()`) gate on `isSealed()`
  instead of checking `size === 0` (`createKeyedRegistry` also provides passive `peekKeys()` and
  `peekHas()` helpers for unsealed inspection).
- **No production unseal API.** Production code cannot reopen a sealed registry. Tests isolate
  dynamic registrations with `vi.resetModules()` or seal per-file testkits (`sealTestRunners`,
  `sealTestRunSlots`, `built-in-*.testkit.ts`).

| Registry | Path | Factory | Built-in registration |
| --- | --- | --- | --- |
| Runners | `core/runner-registry.ts` | `createKeyedRegistry` (reserved `claude-cli`) | `runners/built-in.ts` |
| Removal slots | `runs/removal-slots.ts` | `createListRegistry` (gates, preparations, cleanups) | `built-in-run-slots.ts` |
| Worker executions | `runs/worker-executions-registry.ts` | `createSingleRegistry` | `built-in-run-slots.ts` |
| Agent tools | `ci-wait/tool-registry.ts` | `createKeyedRegistry` (reserved `ci-wait`) | `built-in-tools.ts` |
| Wait kinds | `workflows/run/wait-kind-registry.ts` | `createKeyedRegistry` | `built-in-wait-kinds.ts` |
| Workflow step kinds | `workflows/step-kind-registry.ts` | `createKeyedRegistry` | `workflows/step-kind-registry.ts` |
| CLI commands | `core/cli-registry.ts` | `createKeyedRegistry` | `built-in-cli-commands.ts` |

### 2. Four open extension tables

- **Agent tools (`ci-wait/tool-registry.ts`, controller IPC).** Each `AgentToolDefinition` owns its
  name, static or lazy description and JSON Schema, trigger, label, optional env enablement and
  session env/handlers, transport bounds, zod schema, refusal/hint formatting, and invocation
  handler. Core defines `cezar_wait`, `cezar_ask`, `cezar_cancel_wait`, and `cezar_done`
  (`built-in-tool-definitions.ts`); `preview/agent-tools.ts` defines `cezar_preview_serve` and
  `cezar_preview_stop`; `automations/agent-tools.ts` defines `cezar_schedule_task`,
  `cezar_automation`, and `cezar_scheduled_tasks`. `CiToolController` serves `GET /api/v1/tools`
  (enabled tool metadata, transport hints, and server instructions) and `POST /api/v1/tools/:name`
  (authenticated validation and dispatch) over its private Unix socket or named pipe. External tool
  hosts (`ci-wait/mcp.ts`, `packages/cezar/scripts/pi-ci-wait.mjs`,
  `packages/cezar/scripts/omp-ci-wait.mjs`) fetch the catalog
  at startup over IPC; socketless unit tests of `createCiMcpServer()` read the sealed in-process
  registry directly.
- **Wait kinds (`workflows/run/wait-kind-registry.ts`, open contract `plugin` arm).** Core
  registers `human`, `timer`, `process`, and `subagent` (`workflows/run/wait-kinds.ts`);
  `ci-wait/pr-wait-kind.ts` (`feature:forge`) registers `pr`; `delegation/wait-kinds.ts`
  (`feature:workers`) registers `worker` and `peer`. Each row supplies policy metadata, `cezar_wait`
  input descriptors, registration and deduplication hooks, and a `WaitLifecycle` (`arm`, `disarm`,
  `dispose`, optional `open`, `postOpen`, `reconcile`, `rearm`). `flatWaitInputSchema()` in
  `ci-wait/tool-catalog.ts` builds lazily after the wait-kind registry seals, merging every
  registered kind's declared properties and descriptions into `cezar_wait`'s flat JSON Schema. In
  `packages/contract/src/waits.ts`, `wait-tools.ts`, and `activity.ts`, the seven built-in union
  arms stay strict and one open `kind: 'plugin'` member (`pluginKind`, `summary`, optional
  `deadline`, `via`, `payload`, optional `result`) carries plugin waits. `computeWaitingOn` ranks
  `plugin` after `process` and before `timer`; `deriveAttention` maps it to `monitoring` with
  `label: waitingOn.summary || 'waiting'` (never `needs-you`), and `deriveWebhookState` maps it to
  `'waiting-other'`; cockpit `packages/web/src/routes/task-thread/run-waits.tsx` and
  `packages/web/src/routes/activity/now-box.ts` render `summary` and optional `deadline`, while
  `packages/web/src/lib/run-row-meta.ts` renders `summary` generically. `wait-engine.ts` delegates watch lifecycle to the registered row,
  removing its hardcoded `watches` map and `worker` branch.
- **Workflow step kinds (`workflows/step-kind-registry.ts`, open contract `plugin` step).** Core
  registers `agent` and `check`. `packages/contract/src/workflows.ts` keeps existing `agent`
  (`prompt`/`skill`) and `check` (`command`) YAML syntax unchanged and adds
  `{ id, name?, kind: 'plugin', pluginKind, config?, onFail? }` with a three-way mutual-exclusion
  refinement; `providersRequiredByWorkflow` skips plugin steps. `stepKindSchema` extends to
  `['agent', 'check', 'plugin']`, `StepState` adds optional `pluginKind`, and
  `packages/web/src/routes/task-thread/step-rail.tsx` renders `step.pluginKind ?? step.kind`. `workflows/load.ts` validates registered plugin step kinds
  when sealed, and `workflows/run/step-loop.ts` dispatches execution through the sealed registry.
- **Lazy CLI commands (`core/cli-registry.ts`).** `built-in-cli-commands.ts` registers all 20
  built-in commands with usage lines, `parseMode` (`root` or `subcommand`), `homeMode` (`none`,
  `conditional`, or `unconditional`, with optional `homeEntry(argv)`), `runtimeMode` (`none`,
  `always`, or `(argv) => boolean`), and a lazy `load()` loader. `index.ts` registers and seals
  only the CLI registry before dispatch. `cli-dispatch.ts` generates `hsq --help` from registered
  definitions, and `home/entry.ts` reads `homeMode` metadata from the registry. Only commands whose
  `runtimeMode` is `'always'` or whose `runtimeMode(argv)` predicate returns true run
  `prepareCommandRuntime` (`subcommands.ts`), which dynamically imports, registers, and seals
  runners, removal slots, worker executions, step kinds, agent tools, and wait kinds. Cold commands (`--help`, `--version`, `job`, `artifact`, `message`, `webhook`,
  `automation`, `backup --help`, `remote-settings --help`, and `worker list|inspect|collect|wait`)
  load zero runner or store modules.

### 3. Data-driven lint rules

Plain data modules (`workflows/wait-kind-ids.ts` and `workflows/step-kind-ids.ts`) mirror
`runners/ids.ts` with zero runtime imports, exporting `BUILT_IN_WAIT_KINDS`, `LEGACY_WAIT_KINDS`,
`CONTRACT_WAIT_KINDS`, `BUILT_IN_WAIT_VIAS`, `BUILT_IN_STEP_KINDS`, and `CONTRACT_STEP_KINDS`.
`lint/owner-reader-rules.ts` (`WAIT_KIND_LITERALS`) and `lint/test-enum-literal.ts`
(`TEST_ENUM_VALUES.kind`, `TEST_ENUM_VALUES.via`) read from these modules instead of hardcoding
literal arrays. `workflows/extension-ids.test.ts` holds the data modules aligned with the sealed
built-in registries and contract schemas while proving they import no engine, runner, or feature
module.

## Consequences

- **Four zero-core-edit fixture proofs.** `ci-wait/fixture-tool.test.ts`,
  `workflows/run/fixture-wait.test.ts`, `workflows/plugin-step.test.ts`, and
  `core/cli-registry.test.ts` each register a custom extension and drive it end to end without
  editing any core file.
- **Shrink-only layer baseline reduced.** `packages/cezar/src/lint/layer-import.baseline.json`
  shrank from 102 entries at `b4c0510be` to 93 entries (9 removed): all 7 required feature-crossing
  entries (`ci-wait/client.ts`, `ci-wait/controller.ts`, and `workflows/run/squawk-tools.ts` ->
  `preview/registration.ts`; `ci-wait/tool-env.ts` -> `automations/enabled.ts`;
  `workflows/run/wait-engine.ts`, `wait-kinds.ts`, and `wait-registry.ts` ->
  `ci-wait/supervisor.ts`) plus 2 adjacent entries (`workflows/run/squawk-tools.ts` ->
  `ci-wait/resource-pool.ts` and `workflows/run/wait-registry.ts` -> `delegation/policy.ts`).
- **Cold CLI startup preserved.** `index-runners.test.ts` and `index-run-slots.test.ts` verify that
  cold commands load no runner or store modules while runtime commands register and seal runners,
  removal slots, and worker executions before executing.
- **Fail-closed boot discipline.** Forgetting a registration or seal call now fails at first read
  with a message naming the registry and boot call, rather than silently skipping handlers or gates.
  Because no production unseal API exists, tests that register custom extensions isolate state with
  `vi.resetModules()` or per-file testkits.
- **Deferred work.** External plugin discovery, trust gates, and public API stability start in
  roadmap step 4; moving HTTP routes, WebSocket topics, and deep `workflows/run/compose.ts` /
  `step-loop.ts` feature wiring stays in step 5; cockpit UI slots stay in step 6.

## Considered Options

- **Keep ad-hoc unsealed or empty-checked registries.** Rejected. A process entry that forgot
  registration could read an empty table as "no gates" or "no tools" instead of failing closed.
- **Expose a production `unseal()` or `reset()` helper for tests.** Rejected. Process-wide
  extension tables must stay immutable after boot; `vi.resetModules()` isolates dynamic tests
  without weakening runtime invariants.
- **Build `cezar_wait`'s schema at module import time or keep closed contract unions.** Rejected.
  Outside wait kinds and workflow step kinds could not advertise tool fields or serialize through
  the contract and cockpit without editing core files.

Implementation and reader rules: [CLI area](../areas/cli.md), [workflows area](../areas/workflows.md),
[HTTP API area](../areas/http-api.md), [runs store area](../areas/runs-store.md),
[runners area](../areas/runners.md), and the spec's
[implementation record](../../.ai/specs/2026-11-23-open-registries-and-tables.md#implementation-record).

Coverage under `packages/cezar/src/`: `core/registry.test.ts`, `core/runner-registry.test.ts`,
`runs/removal-slots.test.ts`, `runs/removal-slots-unsealed.test.ts`, `ci-wait/tool-registry.test.ts`,
`ci-wait/fixture-tool.test.ts`, `workflows/run/wait-kind-registry.test.ts`,
`workflows/run/fixture-wait.test.ts`, `workflows/step-kind-registry.test.ts`,
`workflows/plugin-step.test.ts`, `core/cli-registry.test.ts`, `index-runners.test.ts`,
`index-run-slots.test.ts`, `workflows/extension-ids.test.ts`, `test-enum-literal-rule.test.ts`,
and `wait-kind-literal-rule.test.ts`.
