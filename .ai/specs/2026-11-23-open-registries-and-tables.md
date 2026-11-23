# Open registries and small tables
Status: active

Step 3 of [the plugin core roadmap](2026-11-18-plugin-core-roadmap.md), epic
hearsay-tools/squawk#4152. Baseline: `main` at `b4c0510be`. The owner decided the unified
registry lifecycle on 2026-11-23 (task `caba5208`) and the four remaining design and contract
decisions on 2026-11-23 (task `1bc159a9`). The work runs as ten slices, one child issue each;
see [the plan](2026-11-23-open-registries-and-tables-plan.md).

## Goal

Adopt one process-wide registry lifecycle rule (`register -> seal -> read`) across all seven
registries, and open four closed extension tables behind it: agent tools, wait kinds, workflow
step kinds, and CLI commands. After this step:

- all seven process-wide registries (`core/runner-registry.ts`, `runs/removal-slots.ts`,
  `runs/worker-executions-registry.ts`, agent tools, wait kinds, workflow step kinds, and CLI
  commands) use `packages/cezar/src/core/registry.ts` and fail closed when read unsealed;
- `cezar_wait`, `cezar_ask`, `cezar_cancel_wait`, and `cezar_done` register in core, while
  preview and automation tools register from `preview/` and `automations/`;
- `human`, `timer`, and `process` wait kinds register in core, while `pr`, `worker`, `peer`, and
  `subagent` register from their owning modules;
- `agent` and `check` workflow step kinds register through a core step-kind registry;
- all 20 CLI commands register in one lazy CLI command registry that generates `hsq --help` and
  keeps cold startup free of runner and store modules;
- fixture tests register a custom agent tool, wait kind, workflow step kind, and CLI command
  without editing core files;
- `packages/cezar/src/lint/layer-import.baseline.json` holds no `preview` or `automations` entry
  in `ci-wait/*` or `workflows/run/squawk-tools.ts`, and no `forge` entry in `wait-engine.ts`,
  `wait-kinds.ts`, or `wait-registry.ts`;
- contract wait and workflow step unions carry one open `kind: 'plugin'` member whose payload
  the plugin validates, and cockpit views render them generically;
- lint rules (`owner-reader-rules.ts`, `test-enum-literal.ts`) read wait and step kind names from
  plain data modules with no hardcoded lists.

## Out of scope

- Loading plugins from folders outside the repository or enforcing a project trust gate: roadmap
  step 4.
- Stabilizing a public plugin API contract: ADR 0065 rule 3 starts the promise at step 4.
- Moving HTTP routes, WebSocket topics, `workflows/run/step-loop.ts` -> `agent-config/seed.ts`,
  or deep feature wiring in `workflows/run/compose.ts`: roadmap step 5.
- Cockpit UI slots or sandboxed plugin panels: roadmap step 6.
- Changing what any shipped agent tool, wait kind, workflow step kind, or CLI command does at
  shipped defaults.

## Done when

- **Outcome:** all ten child issues (hearsay-tools/squawk#4154 to hearsay-tools/squawk#4163) are
  closed on `main`, this spec is `Status: done`, its `-plan.md` is removed, the roadmap marks
  step 3 Done, and ADR 0069 records the registry rule and four open tables.
- **Proof:** `npm run prepr` and CI pass; unit tests cover `core/registry.ts` and unsealed
  fail-closed behavior on all seven registries; four fixture tests prove a custom tool, wait kind,
  step kind, and CLI command work with zero edits to core; `index-runners.test.ts` and
  `index-run-slots.test.ts` confirm cold CLI commands load no runner or store modules;
  `layer-import.baseline.json` drops the seven required feature entries.
- **Failure:** reading any unsealed registry throws an error naming the registry and its boot
  call; writing after `seal()` or registering a conflicting or legacy key throws; unregistered
  tool names, wait kinds, step kinds, and CLI commands fail closed with clear refusals.

## Evidence

Measured on `main` at `b4c0510be` (2026-11-23). `layer-import.baseline.json` holds 102 entries.

| Area | File | Lines | Notes |
| --- | --- | ---: | --- |
| Existing registries | `core/runner-registry.ts` | 111 | Checks `registry.size === 0`; ~271 test files call `registerRunner(` directly |
| Existing registries | `runs/removal-slots.ts` | 114 | Sealed list registry; `registerBuiltInRunSlots()` currently seals inline |
| Existing registries | `runs/worker-executions-registry.ts` | 50 | Unsealed single-slot registry |
| Agent tools | `ci-wait/tool-catalog.ts` | 157 | 9 tools (4 core, 2 preview, 3 automations); `flatWaitInputSchema()` runs at import time |
| Agent tools | `ci-wait/tools.ts` | 116 | Closed `TOOLS_BY_NAME` map, triggers, labels, invoke wrappers |
| Agent tools | `ci-wait/tool-names.ts` | 22 | Leaf name and env allowlist helpers |
| Agent tools | `ci-wait/tool-env.ts` | 12 | Feature flags; imports `automations/enabled.ts` |
| Agent tools | `ci-wait/controller.ts` | 309 | Hardcoded IPC Hono routes for 9 tools; imports `preview/registration.ts` |
| Agent tools | `ci-wait/client.ts` | 111 | Hardcoded IPC wrappers; imports `preview/registration.ts` |
| Agent tools | `ci-wait/mcp.ts` | 29 | Stdio MCP server child process |
| Agent tools | `workflows/run/squawk-tools.ts` | 129 | Session handlers; imports `preview/registration.ts` and `ci-wait/resource-pool.ts` |
| Wait kinds | `workflows/run/wait-kinds.ts` | 601 | Closed `WAIT_KINDS` table (7 kinds); imports `ci-wait/supervisor.ts` |
| Wait kinds | `workflows/run/wait-engine.ts` | 436 | Closed `watches` map + `worker` branch; imports `ci-wait/supervisor.ts` |
| Wait kinds | `workflows/run/wait-registry.ts` | 361 | Per-kind registration paths; imports `ci-wait/supervisor.ts` and `delegation/policy.ts` |
| Wait contract | `packages/contract/src/waits.ts` | 470 | Closed `waitSchema`, `openWaitSchema`, `waitingOnSchema`, `waitViaSchema` |
| Wait contract | `packages/contract/src/wait-tools.ts` | 162 | Closed `squawkWaitRequestSchema`, `squawkWaitAnswerSchema` |
| Wait contract | `packages/contract/src/waiting-on.ts` | 129 | `computeWaitingOn` switches over built-in wait kinds |
| Step kinds | `workflows/types.ts` | 204 | `stepKind(step)` returns `'agent' \| 'check'` |
| Step kinds | `workflows/run/step-loop.ts` | 557 | `if (kind === 'agent') ... else runCheckStep(...)` |
| Step contract | `packages/contract/src/workflows.ts` | 153 | `workflowStepDefSchema` XOR refinement (`command` vs `prompt`/`skill`) |
| Step contract | `packages/contract/src/run-status.ts` | 32 | `stepKindSchema = z.enum(['agent', 'check'])` |
| CLI commands | `subcommands.ts` | 77 | 13 subcommands in `loadSubcommand` switch + `prepareCommandRuntime` |
| CLI commands | `cli-dispatch.ts` | 229 | 7 top-level commands + static `cliHelp()` |
| CLI commands | `home/entry.ts` | 88 | Hardcoded `entries` and `unconditional` operator Home arrays |

### Direct `layer-import.baseline.json` targets (7 required removals)

| File | Target | Layer | Removed by |
| --- | --- | --- | --- |
| `ci-wait/client.ts` | `preview/registration.ts` | `feature:preview` | A2 |
| `ci-wait/controller.ts` | `preview/registration.ts` | `feature:preview` | A2 |
| `ci-wait/tool-env.ts` | `automations/enabled.ts` | `feature:automations` | A2 |
| `workflows/run/squawk-tools.ts` | `preview/registration.ts` | `feature:preview` | A2 |
| `workflows/run/wait-engine.ts` | `ci-wait/supervisor.ts` | `feature:forge` | B3 |
| `workflows/run/wait-kinds.ts` | `ci-wait/supervisor.ts` | `feature:forge` | B3 |
| `workflows/run/wait-registry.ts` | `ci-wait/supervisor.ts` | `feature:forge` | B3 |

Adjacent entries (`workflows/run/squawk-tools.ts` -> `ci-wait/resource-pool.ts`,
`workflows/run/wait-registry.ts` -> `delegation/policy.ts`, and `ci-wait/errors.ts` ->
`delegation/policy.ts`) may also shrink in A2 or B3 if their wiring moves cleanly.

## Owner decisions (2026-11-23)

1. **One registry lifecycle rule (`core/registry.ts`, task `caba5208`).** All process-wide
   registries use `register -> seal -> read` through `createKeyedRegistry`, `createListRegistry`,
   and `createSingleRegistry`:
   - Every registry starts unsealed; normal reads fail closed with an error naming the registry
     and its boot call.
   - Re-registering the exact same object/function reference is a no-op (before or after seal).
   - Conflicting keys, reserved legacy keys, or a second distinct single-slot value throw.
   - Any new write after `seal()` throws; `seal()` is idempotent.
   - `register*()` functions only register and never seal; the boot boundary seals after all
     registrations run.
   - Sealing is per registry, so cold CLI commands seal only CLI commands and unit tests seal
     only the registries they need.
   - Single-slot `get()` throws when unsealed or when sealed empty; passive cold reads (such as
     `runs/legacy-run-rows.ts`) check `isSealed()` instead of `size === 0`.
2. **Migration timing (task `caba5208`).** Slice 0 adds `core/registry.ts` and migrates
   `runs/removal-slots.ts`, `runs/worker-executions-registry.ts`, and `core/runner-registry.ts`
   before adding step 3's four new registries.
3. **Plugin wait kinds in `cezar_wait`, contract, and cockpit (task `1bc159a9`).**
   - In `cezar_wait`, a plugin wait kind registers its own `kind` name (for example `kind: "deploy"`)
     and JSON Schema fields directly into `flatWaitInputSchema()`, built lazily after the wait-kind
     registry seals (ADR 0065 rule 1). Built-in arms stay strict; unregistered names fail closed.
   - In `packages/contract/src/waits.ts`, `wait-tools.ts`, and `activity.ts`, built-in union arms
     stay strict and one open `kind: 'plugin'` member is added with `pluginKind`, `summary`,
     optional `deadline`, `via: string` (on the plugin arm only; built-in `waitViaSchema` stays
     strict), `payload: Record<string, unknown>`, and optional `result: Record<string, unknown>`.
   - In `computeWaitingOn`, `plugin` waits rank after `process` and before `timer`. In
     `deriveAttention`, a `plugin` wait maps to `monitoring` with `label: waitingOn.summary`
     (never `needs-you`) and webhook state `waiting-other`. Cockpit `run-waits.tsx`,
     `run-row-meta.ts`, and `activity/now-box.ts` render `summary` and optional `deadline`
     generically.
4. **Plugin workflow steps in YAML and contract (task `1bc159a9`).** Existing `agent`
   (`prompt`/`skill`) and `check` (`command`) YAML syntax stays unchanged. Add one open step
   member `{ id, name?, kind: 'plugin', pluginKind, config?, onFail? }` (mutually exclusive with
   `prompt`/`skill` and `command`). Extend `stepKindSchema` to `['agent', 'check', 'plugin']`, add
   optional `pluginKind` to `StepState` so `step-rail.tsx` displays `pluginKind ?? step.kind`, and
   skip plugin steps in `providersRequiredByWorkflow`.
5. **External tool hosts discover tools over controller IPC (task `1bc159a9`).** `CiToolController`
   serves `GET /api/v1/tools` (session-enabled registered tool metadata + server instructions) and
   `POST /api/v1/tools/:name` (validated dispatch to the registered tool handler) over its existing
   private Unix socket / named pipe. `ci-wait/mcp.ts`, `scripts/pi-ci-wait.mjs`, and
   `scripts/omp-ci-wait.mjs` fetch the catalog from the controller at startup, with direct
   in-process registry lookup for socketless unit tests.
6. **Execution scope and merge authority (task `1bc159a9`).** Task `1bc159a9` lands this spec PR,
   files all ten child issues, and coordinates all slices through integrated acceptance on `main`.
   The coordinator may squash-merge approved slice PRs once CI, pre-PR review, and all review
   threads are clean; paths on the auto-merge never-list (`AGENTS.md`, gate/harness files) still
   wait for owner approval.

## Design

### 1. Shared registry primitive (`packages/cezar/src/core/registry.ts`)

`core/registry.ts` is a pure `core` module with zero runtime dependencies outside the standard
library. It exports three factories:

- `createKeyedRegistry<K extends string, V>(options)`: keyed map with optional reserved/legacy
  keys (`reservedKeys?: ReadonlyMap<K, string> | ReadonlySet<K>`), `register(key, value)`,
  `seal()`, `isSealed()`, `get(key)`, `has(key)`, `values()`, `keys()`, `entries()`, and passive
  `peekKeys()` / `peekHas(key)` for cold saved-data readers that check `isSealed()` explicitly.
- `createListRegistry<V>(options)`: ordered list (for removal slots: gates, preparations,
  cleanups) with `register(item)`, `seal()`, `isSealed()`, and `values()`.
- `createSingleRegistry<V>(options)`: single optional factory slot (for `worker-executions-registry`)
  with `register(value)`, `seal()`, `isSealed()`, `has()`, and `get()` (throws if unsealed or if
  sealed with no value).

Every factory takes `{ name: string; bootHint: string }` so unsealed-read errors name both the
registry and its boot call. No production unseal or reset method exists; tests isolate dynamic
registrations with `vi.resetModules()` or seal per-file testkits.

### 2. Agent tool registry (`ci-wait/tool-registry.ts` + IPC controller)

- A registered `AgentToolDefinition` holds: `name`, `description` (or lazy builder `describe()`),
  `inputSchema` (or lazy builder `buildInputSchema()`), `trigger`, `label`, optional
  `enabled(env)`, optional `envNames(env)`, optional `maxBodyBytes`, optional `timeoutMs`,
  input validation / refusal formatting, client-side invoke/hint formatting, and server-side
  session handler binding.
- Core registers `cezar_wait`, `cezar_ask`, `cezar_cancel_wait`, and `cezar_done`.
- `preview/` registers `cezar_preview_serve` and `cezar_preview_stop`.
- `automations/` registers `cezar_schedule_task`, `cezar_automation`, and `cezar_scheduled_tasks`.
- `CiToolController.provision(...)` receives session capabilities (core handlers plus optional
  feature capability map keyed by tool or feature) and serves:
  - `GET /api/v1/tools` -> enabled tool definitions, labels, triggers, and `instructions`;
  - `POST /api/v1/tools/:name` -> capability auth, body limit, feature enablement check, schema
    validation, and handler invocation.
- `ci-wait/tool-names.ts` reads registered enabled tool names and env names from the sealed tool
  registry (keeping runner allowlists and `--tools` flags in sync with registered tools).
- `ci-wait/mcp.ts`, `scripts/pi-ci-wait.mjs`, and `scripts/omp-ci-wait.mjs` fetch their tool list
  from `GET /api/v1/tools` over `CEZ_TOOL_SOCKET` (using top-level `await`) and invoke tools via
  `POST /api/v1/tools/:name`. Unit tests that instantiate `createCiMcpServer()` without a socket
  read the sealed in-process tool registry directly.

### 3. Wait-kind registry (`workflows/run/wait-kind-registry.ts` + contract open member)

- Built-in contract union arms (`pr`, `timer`, `human`, `worker`, `process`, `peer`, `subagent`)
  stay strict. One open `pluginWaitEntrySchema` arm adds:
  - `kind: z.literal('plugin')`, `pluginKind: z.string().min(1).max(64)`,
  - `via: z.string().min(1).max(64)` (built-in `waitViaSchema` stays strict),
  - `deadline: z.iso.datetime().optional()`,
  - `summary: z.string().max(256)`,
  - `payload: z.record(z.string(), z.unknown())`,
  - `result: z.record(z.string(), z.unknown()).optional()`.
- `openWaitSchema`, `waitingOnSchema`, and `activityWaitSchema` each gain a matching `kind: 'plugin'`
  member (`pluginKind`, `summary`, optional `deadline`).
- `squawkWaitRequestSchema` keeps its strict built-in arms and admits a plugin wait request arm
  whose `kind` is validated at runtime against the sealed wait-kind registry; `squawkWaitAnswerSchema`
  accepts registered wait kinds and optional deadline when a plugin wait has none.
- `workflows/run/wait-kind-registry.ts` uses `createKeyedRegistry` to store `WaitKindRow` entries
  keyed by stored kind (or `pluginKind` for plugin waits). Each row provides its own watch
  lifecycle adapter (`arm` / `disarm` / `dispose`), registration handler, duplicate/canonicalize
  logic, formatting, charging rule, and optional `cezar_wait` schema descriptor.
- `flatWaitInputSchema()` runs lazily when `cezar_wait`'s schema is requested after seal, merging
  each registered wait kind's declared JSON Schema properties and descriptions.
- Core registers `human`, `timer`, and `process`. Forge registers `pr`; `delegation/` registers
  `worker` and `peer`; runner/subagent wiring registers `subagent`. `wait-engine.ts` delegates
  watch arming, post-open hooks, and entry lookup to the registered row, removing its hardcoded
  `watches` map and `worker` branch.

### 4. Workflow step-kind registry (`workflows/step-kind-registry.ts` + contract open member)

- `packages/contract/src/workflows.ts` keeps existing `agent` (`prompt`/`skill`) and `check`
  (`command`) step fields unchanged and adds optional `kind: z.literal('plugin')`,
  `pluginKind: z.string().min(1).max(64)`, and `config: z.record(z.string(), z.unknown())` with a
  three-way mutual-exclusion refinement (`command` vs `prompt`/`skill` vs `kind: 'plugin'`).
- `packages/contract/src/run-status.ts` extends `stepKindSchema` to `z.enum(['agent', 'check', 'plugin'])`.
  `StepState` in `packages/contract/src/runs.ts` adds optional `pluginKind: z.string().min(1).max(64)`.
- `workflows/step-kind-registry.ts` uses `createKeyedRegistry` to register `StepKindDefinition`
  entries (`kind`, `validate?`, `requiresRunner`, `execute(context)`).
- Core registers `'agent'` and `'check'`. `workflows/run/step-loop.ts` looks up the registered
  executor (`step.kind === 'plugin' ? step.pluginKind : stepKind(step)`) instead of branching with
  `if (kind === 'agent') ... else runCheckStep(...)`.

### 5. Lazy CLI command registry (`core/cli-registry.ts`)

- `core/cli-registry.ts` uses `createKeyedRegistry` to store `CliCommandDefinition` entries:
  `name`, `usage` (one or more help lines), `summary`, `section`, `parseMode` (`'subcommand'` vs
  `'root'`), `homeMode` (`'none' | 'conditional' | 'unconditional'`, plus optional `homeEntry(argv)`
  predicate for `backup` / `run`), `runtimeMode` (`'none' | 'always'` or predicate `(argv) => boolean`
  for `worker`, `backup`, `remote-settings`), and lazy `load()`.
- `src/built-in-cli-commands.ts` registers all 20 commands with zero eager imports of runner,
  store, server, or feature modules, and `src/index.ts` seals only the CLI command registry before
  dispatch.
- `cli-dispatch.ts` generates `hsq --help` from registered definitions, and `home/entry.ts` reads
  registered `homeMode` metadata instead of maintaining separate `entries` and `unconditional`
  arrays.
- Only commands whose `runtimeMode(argv)` returns true dynamically import and register runners,
  removal slots, tools, wait kinds, and step kinds, then seal them. Cold CLI commands (`--help`,
  `--version`, `job`, `artifact`, `worker list`, `backup --help`, `remote-settings --help`) seal
  only the CLI registry and load zero runner or store modules.

### 6. Data-driven lint rules and close-out

- Plain data modules (mirroring `runners/ids.ts`) export `BUILT_IN_WAIT_KINDS`, `LEGACY_WAIT_KINDS`,
  `BUILT_IN_WAIT_VIAS`, and `BUILT_IN_STEP_KINDS` without importing engine or runner code.
- `lint/owner-reader-rules.ts` and `lint/test-enum-literal.ts` import those data tables instead of
  hardcoding literal arrays.
- Final slice E1 updates documentation, removes the `-plan.md` file, marks this spec `Status: done`
  with its implementation record and measurements, updates the roadmap, and writes ADR 0069.

## Case tables

### Registry lifecycle cases (`core/registry.ts`)

| Case | Registry state | Behavior at shipped defaults |
| --- | --- | --- |
| Normal read (`get`, `has`, `values`, `keys`) | Unsealed | Throws naming the registry and its boot call |
| Passive cold read (`isSealed()`, `peekKeys()`, `peekHas()`) | Unsealed | Returns `false` / empty / `false` without throwing |
| `register(key, ref)` with new key | Unsealed | Stores entry in registration order |
| `register(key, sameRef)` (identical reference) | Unsealed or sealed | No-op |
| `register(key, otherRef)` (different reference) | Unsealed or sealed | Throws conflict error naming `key` |
| `register(legacyKey, ref)` (reserved key) | Unsealed or sealed | Throws legacy-key error naming `legacyKey` |
| `register(newKey, ref)` | Sealed | Throws sealed-registry error |
| `seal()` called once or multiple times | Unsealed or sealed | Marks sealed; idempotent |
| Single-slot `get()` | Sealed empty | Throws naming missing registration and boot call |
| Single-slot `get()` | Sealed with factory | Returns factory |

### Open plugin wait cases (contract, attention, cockpit)

| Case | `computeWaitingOn` | `deriveAttention` / webhook | Cockpit display |
| --- | --- | --- | --- |
| Open `plugin` wait alongside `human` or `pr` or `process` | Higher-priority wait wins | Higher-priority rung / webhook | Task thread lists both open waits |
| Open `plugin` wait alongside `timer` | `plugin` wins (before `timer`) | `monitoring` rung (`label: summary`), webhook `waiting-other` | Task thread and Activity show `summary` and optional `deadline` |
| Open `plugin` wait without `deadline` | `plugin` with no `deadline` | `monitoring` rung (`label: summary`), webhook `waiting-other` | Renders `summary` with no deadline line |
| Resolved `plugin` wait owed to agent | None open -> `hasResolvedWait` | `waiting-for-capacity` | Shows owed result until delivered |
| Unregistered `pluginKind` on stored run after restart | Still parses under `waitSchema` | Still derives attention cleanly | Renders `summary` without crashing; engine logs warning rather than throwing on load |

## Implementation record

Epic hearsay-tools/squawk#4152. Updated as each slice merges on `main`.

| Slice | Issue | Pull request | Commit on `main` | Notes |
| --- | --- | --- | --- | --- |
| Spec & plan | hearsay-tools/squawk#4152 | Pending | Pending | Records owner decisions and plan |
| S0a | hearsay-tools/squawk#4154 | Pending | Pending | `core/registry.ts` + removal slots & worker executions |
| S0b | hearsay-tools/squawk#4155 | Pending | Pending | `core/runner-registry.ts` register-then-seal |
| A1 | hearsay-tools/squawk#4156 | Pending | Pending | Core agent tool registry + IPC catalog/dispatch |
| A2 | hearsay-tools/squawk#4157 | Pending | Pending | Preview & automation tools move + fixture test |
| B1 | hearsay-tools/squawk#4158 | Pending | Pending | Contract open plugin wait + cockpit fallbacks |
| B2 | hearsay-tools/squawk#4159 | Pending | Pending | Core wait-kind registry + lazy `cezar_wait` schema |
| B3 | hearsay-tools/squawk#4160 | Pending | Pending | Forge, worker, peer, subagent waits move + fixture test |
| C1 | hearsay-tools/squawk#4161 | Pending | Pending | Open workflow step kinds + fixture test |
| D1 | hearsay-tools/squawk#4162 | Pending | Pending | Lazy CLI command registry + fixture test |
| E1 | hearsay-tools/squawk#4163 | Pending | Pending | Data-driven lint rules, docs, ADR 0069, spec close-out |
