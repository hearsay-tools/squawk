# AGENT_PROTOCOL.md — the Squawk agent protocol

Squawk runs every coding-agent CLI behind one seam, `AgentRunner`, and renders every backend
through one event vocabulary. This file holds the rules for that seam that code, types, tests
and lint rules do not state. When this file and the code disagree, the code wins.

Every runner emits two event streams together: v1 `AgentEvent` (§2) and v2 `UiEvent` (§3).

---

## 1. The runner seam (`packages/cezar/src/core/agent-runner.ts`)

The types in `agent-runner.ts` and their doc comments are the contract: `AgentRunner`,
`AgentSession`, `SessionOptions`, `AgentRunSpec`, `InputDelivery` and `SystemPromptOnResume`.
`RUNNER_FACTS` in `core/runner-facts.ts` reads what each runner's wire can do from the
registered definitions; each runner declares it in `runners/<id>/facts.ts`. The `display` part of
a definition (`runners/<id>/display.ts`) holds what the cockpit and the server both read: the
display name, the model list name, the model id scope, the runner picker's label and line, the
icon key, the install hint, the login command and the account folder example. The `models` part
adds the picker's `suggested` presets and the `retired` ids; the `configFiles` part adds the
`agentConfig` pane of Settings → Agent config. The server reads them from the registry; the
cockpit reads them from `GET /api/v1/runners` and holds no table keyed by runner id. A runner's definition holds how a terminal
starts and resumes its CLI and where the installer gets it (`cli`, from `runners/<id>/cli.ts`;
`core/runner-cli.ts` reads it), and how the host probe finds it (`detection`, from
`runners/<id>/detection.ts`; `core/backend-detect.ts` runs the probe). Each runner's
`*_SPEC_SUPPORT` constant, in `runners/<id>/spec-support.ts`, says which `AgentRunSpec` fields
its wire honors; the definition and the adapter class read that file.

- `.ai/scripts/probe-steering.ts` probes the `inputDelivery` of a real CLI. It spends a paid
  session, so run it by hand.
- The delegation CLI (`hsq worker`, `hsq message`) is agent-facing and has no compatibility
  window: change or remove a verb without an alias. This does not apply to human commands
  such as `hsq task send`.

---

## 2. v1 `AgentEvent` — the flat stream

`AgentEvent` in `packages/cezar/src/core/agent-runner.ts` is the v1 stream. Every runner
emits it beside v2: `hsq run` renders it and saved runs hold it. New consumers read runner
output from v2. A Squawk-owned run event, such as `provider-auth-required`, has no v2 form
and arrives as `run-event` (§9). Saved runs keep the v1 `type` strings readable (§ Saved events).

---

## 3. v2 `UiEvent` — the normalized protocol (`packages/cezar/src/core/ui-events.ts`)

`ui-events.ts` holds the vocabulary and imports no runtime code.
`packages/api-client/src/protocol/ui-events.ts` is a hand-kept copy for the browser;
`packages/cezar/src/server/api-types.test.ts` holds the two equal on the wire.

Where a name is an arbitrary choice (tool status, tool kind, plan entry, diff shape, stop
reason), use the ACP name.

---

## 4. Per-backend mapping (summary)

Each backend's mapper is `packages/cezar/src/runners/<id>/<id>-ui-mapper.ts`. Its golden
fixtures (§8) are the wire-to-event table.

<a id="codex-managed-permissions-708"></a>

### Codex managed permissions

`packages/cezar/src/runners/codex/codex-permissions.test.ts` holds the rules: when Squawk selects its
own sandbox, and when Codex's managed permissions stay.

### Codex approval routing

`packages/cezar/src/runners/codex/codex-approvals.test.ts`, `packages/cezar/src/runners/codex/codex-permission-recovery.test.ts` and
`packages/cezar/src/workflows/permissions.test.ts` hold who can answer a native approval and
what recovery does with one.

#### MCP tool approvals

`packages/cezar/src/core/ci-tools.testkit.ts` holds how Codex treats Squawk's own MCP server.
`.ai/scripts/probe-approvals.ts` checks that routing against the installed Codex in one paid
turn. CI never runs it.

---

## 5. The tool display model (`packages/contract/src/tool-display.ts`)

`toolDisplay(name, input)` computes a tool's kind, title and subtitle. Call it for every
tool title and never build one in a component: the thread, the activity groups and the
notifications must show the same line.

---

## 6. Backend parity — the hard rule (`packages/cezar/src/core/ui-parity.test.ts`)

`ui-parity.test.ts` holds the matrix and its rule: every backend emits every capability, so
the GUI degrades per capability, never per backend. It asserts each capability over each
backend's golden-fixture expected output. A real upstream gap takes a named exemption in
that file, with the version surveyed and an inverse assertion. A missing implementation is
never a wire gap.

§6 covers what a mapper emits. §7 covers what a runner does. A backend satisfies both.

### Native skills

Each runner's definition loads its list adapter through `loadSkillCatalog`, and
`core/host-skill-catalog.ts` builds the catalog's adapters from the registry. Its
`discover({ runner, cwd, accountHome }, signal)` call returns `{ skills, problems }`
without a model turn: Claude `get_skills_dialog`, Codex `skills/list`, OpenCode
`GET /skill`, pi RPC `get_commands`, omp `omp skill list --json`.
`AgentRunSpec.skill = { id, path?, args }` opens a native skill turn; later input uses
one `skill` content block in first position. `resumeFallbackSkill` triggers only on a
fresh-session fallback, never on an actual resume. The adapter reports `session.resumed`.

| Runner | Native trigger | `skillTriggerMidTurn` | `skillUnknownName` | `skillsSeenBySession` |
| --- | --- | --- | --- | --- |
| Claude | Last text block `/id args`; opening context in an earlier block | `false` | `silent` | `at-start` |
| Codex | Structured skill item with the listed path plus text args on `turn/start`; never on steer or an active turn | `false` | `silent` | `live` |
| OpenCode | `POST /session/{id}/command`; read the response in the background, SSE owns progress | `false` | `error` | `at-start` |
| pi | Leading `/skill:id args`, with an argument on the same line; context after args | `true` | `silent` | `at-start` |
| omp | `/skill:id args`; map the custom `skill-prompt` message once | `true` | `silent` | `at-start` |

`core/runner-facts.ts` owns these facts. Shared code uses them to hold busy-turn
triggers and choose the session's opening list or a live read. Selected-skill resolution
and typed-name rules live in [Skills](docs/areas/skills.md).

<a id="waits"></a>
<a id="ci-wait-tool-contract-474"></a>

## Waits (hearsay-tools/cezarion#1233, hearsay-tools/cezarion#1234; CI since hearsay-tools/cezarion#474)

A run keeps its waits in one list on its record. The agent opens and closes them with the Squawk
tools. Read each fact from its owner:

- `packages/contract/src/waits.ts`, `ci-wait.ts` and `ask-schema.ts`: the stored wait shapes, and
  each tool's request, answer, limits and error codes.
- `WAIT_KINDS` in `packages/cezar/src/workflows/run/wait-kinds.ts`: one typed row for each wait
  kind, with its deadline, slot, wake budget, resolvers, cancel paths and texts. A new kind is a
  new row ([ADR 0061](docs/adr/0061-one-wait-engine-executes-wait-kind-rows.md)).
- `squawkTools` in `packages/cezar/src/ci-wait/tools.ts`: the one list of Squawk tools, with the
  descriptions that the agent reads. Every runner's adapter, extension and allow-list read
  it, and `squawkToolEnvNames` lists the environment names a harness forwards. A new tool is
  one entry there. `errors.ts` beside it and `workflows/completion-policy.ts` hold the refusal
  messages.
- `packages/contract/src/automation-tool.ts`: `cezar_automation` creates repeating automations
  paused, shows them, previews GitHub polls and enables them only with explicit consent.
  Preview evidence belongs to the calling capability's lifetime signal and current definition
  revision. Continue and recovery must preview again. Its gate is `automationsToolEnabled`,
  shared with the unchanged one-time schedule tools.
- The `CI_*` constants in `packages/cezar/src/ci-wait/supervisor.ts` and `github.ts`: the PR
  watcher bounds. `packages/cezar/src/workflows/run/constants.ts`: the wake and delivery bounds.
- `.ai/specs/2026-10-17-unified-waits.md`: the model (the turn-end rule, waking, slots and
  liveness bounds).

A wait result is an observation. It grants no merge, review-acceptance or task-completion
authority.

### Private transport and required harness evidence

- A memory-only session capability binds project, run and generation. The capability, not the
  model, names the calling run. `CEZ_TOOL_TOKEN` and `CEZ_TOOL_SOCKET` exist only in the child
  environment: never write them to a prompt, a record, a descriptor snapshot or a setting.
- This is cooperative same-user authorization, not isolation from an unrestricted shell.
- An explicit tool denial stays a denial.
- Before a runner ships, the parity rows must list and call the tools through its native mock
  wire and the real bundled adapter or extension, on fresh, Continue and recovery paths. An argv
  or configuration snapshot is not transport proof.
- A wire limitation needs owner review and a named exemption. Do not skip the row silently,
  widen a permission, or fall back to a marker or to model polling.
- Record the installed interface and version that you checked in
  `packages/cezar/src/ci-wait/__fixtures__/README.md` or in the runner's fixture README.

## 7. Harness parity — session and lifecycle (`packages/cezar/src/core/harness-parity.test.ts`)

The harness matrix drives each real runner class through its native mock. Every criterion
holds for every runner, or carries a `PARITY_EXEMPTIONS` entry whose reason names the wire
limitation. A row that tests Squawk's shared logic above the seam runs on one runner,
`SCENARIO_RUNNER`, instead (docs/adr/0063-one-scenario-runner.md).

Shutdown rows S27/S28 retain process-group cleanup for every runner. A runner declaring
`facts.shutdownDescendants = observed-tree` must also reap the observed detached command;
`process-group` retains the detached-survivor assertion. Abrupt-exit rows S30/S31 do not
assume a snapshot and retain their original checks.

Print every row with its exemptions:

```bash
node packages/cezar/scripts/parity-rows.ts
```

`--row R39` prints one row. `--runner pi` prints only the rows that the runner is exempt
from, not the rows that run on it. `--json` prints the index as JSON.

Owners. Paths are relative to `packages/cezar/src/`.

- **Rows** (`{ id, name, scenario }`): the kit modules that `KITS` in
  `packages/cezar/scripts/parity-rows.ts` names. The largest are the `*_CRITERIA` tables in
  `core/harness-parity-core.testkit.ts`, the row lists in
  `core/harness-parity-rows.testkit.ts` and `WAIT_CRITERIA` in
  `workflows/waits-parity.testkit.ts`.
- **Cells:** `core/harness-parity-cells.testkit.ts`,
  `workflows/waits-parity-<part>-cells.testkit.ts` (one module per wait part, registered
  together in `workflows/waits-parity-cells.testkit.ts`) and the testkit of each other family.
  `PARITY_FILES` in `core/parity-classes.testkit.ts` maps every parity test file to its
  family.
- **Exemptions and their kinds:** `PARITY_EXEMPTIONS` and `ExemptionKind` in
  `core/harness-parity-core.testkit.ts`. The table holds the rows it selects by facts and the
  rows that span every runner but one. A row for one runner is that runner's
  `mock.parityExemptions` (`runners/<id>/mock.ts`), which the table reads; A9 is declared there
  exactly where `facts.nativeAsk` is not `answerable`. The wait rows use the same table, except
  the subagent wait rows: `SUBAGENT_EXEMPTIONS` in `workflows/waits-subagents-rows.testkit.ts`.
- **Tiers:** `driveSeam` (`core/harness-parity-core.testkit.ts`) drives a real runner class
  against its own offline mock. `driveRun` (`core/workflow-parity-core.testkit.ts`) drives a
  real `RunManager` run in a temp git repo.
- **Scenario catalog:** `SCENARIOS` in `core/harness-parity-core.testkit.ts`. Each runner's
  prompt for a scenario is in the `mock` part of its definition (`runners/<id>/mock.ts`);
  `HARNESS_ADAPTERS` in the same kit reads it from the registry. The steps of each scenario are in
  `packages/cezar/scripts/mock-scenario.mjs`.
- **Row classes, the scenario runner and the fact-value unit tests:** `PARITY_FAMILIES`,
  `SCENARIO_RUNNER` and `FACT_VALUE_TESTS` in `core/parity-classes.testkit.ts`.
- **Spec-support rows:** `SPEC_FIELD_PROBES` in `core/harness-parity-cells.testkit.ts`.
- **Per-runner files:** `runners/<id>/harness-<id>-<part>-parity.test.ts`
  (`harnessParityFile`) and `runners/<id>/waits-<id>-<part>-parity.test.ts`
  (`WAIT_PARITY_FILES`, `FAMILY_FILE_PARTS`, `WAIT_FOLDS` in
  `workflows/waits-parity-catalog.testkit.ts`). A part in `FAMILY_FILE_PARTS` runs one
  `waits-<runner>-<part>-<family>-parity.test.ts` file per row family.
- **Matrix guards and single-runner cells:** `core/harness-parity.test.ts` and
  `workflows/waits-parity.test.ts`.

[docs/areas/runners.md](docs/areas/runners.md) holds the rules for a parity row, for a
per-runner file and for regression coverage. Rules that no check holds:

- A red cell is a runner bug until proven otherwise. Fix the runner. Do not weaken the row.
- A new mock scenario is wire-faithful, as §8 requires of a fixture.
- A native mock matches `mock:<scenario>` over all the native user text it receives. That text
  includes what Squawk adds: in-thread system instructions, resume context and
  `<cezar-context>` blocks. A change that adds text to an opening message strips that text
  before the mock matches, in `packages/cezar/scripts/mock-session-context.mjs`. The mock
  still records the raw text, because tests assert what Squawk sent.

Autosave process attribution is observation, not OS containment: `autosave-holders.ts` and
`autosave-windows.ts` say what it cannot see.

### Human input holds

`AgentSession.holdsHumanInput` releases a follow-up when its carrying normalized turn
starts, when the wire reports a read inside an open turn, or on rejection, close or discard.
For `inputDelivery.consumption: unobservable`, an early steering acknowledgement keeps the
hold until the carrying `turn.completed`. A late steer keeps its hold until the successor
`turn.started`. An acknowledgement alone never proves consumption. Observable wires keep
their existing release points. The Antigravity runner tests cover both steering orders and
rejection, close and discard.

### Continue: session and step (hearsay-tools/cezarion#2991)

`continuedSessionId` and `resumableSessionId` in `workflows/run/launch-read-resolver.ts` own
which step a Continue continues and which session it resumes.
`workflows/native-session-continue.test.ts` drives every runner through them.
`continuationDefStep` in `delegation/execution-identity.ts` names the workflow step that the
continued session's owner runs as: its skill, grants, model, effort and worker identity.
`latestSessionStep` in the contract's `run-predicates.ts` names the latest session: the step with
a session that started last. A Continue appends its step, so the array order is not time order.

| State | Trigger | Who or what fires it | Behavior at shipped defaults |
| --- | --- | --- | --- |
| latest session owned by workflow step `implement` | Continue | the user, a parent, recovery | runs as `implement`; the synthetic `continue-N` records `continuesStepId: implement` |
| latest session owned by `continue-N` with `continuesStepId: implement` (for example its process crashed) | Continue | the user, a parent, recovery | runs as `implement`, on a mixed-runner chain too (hearsay-tools/squawk#3024) |
| latest session owned by a saved `continue-N` without `continuesStepId` | Continue | the user, a parent, recovery | runs as the chain's last agent step, as before; the new `continue-N` records no `continuesStepId` |
| a `resume` cursor on failed step `implement` | Continue | the user, a parent, recovery | runs as `implement` and records it |
| `continue-1` of `implement` called done, then `review` ran with its own session | Continue | the user, a parent, recovery | runs as `review`, whose session started last |
| a `continue-N` with `continuesStepId: implement` | the Continue's done | the agent | the `workflowCursor` and the step statuses decide the next step, as before; `continuesStepId` sets no position, so a recovered failed attempt stays failed and the chain does not run again |

Only `workflows/continuation-admission.ts` writes `continuesStepId`, once, when it admits the
Continue (ADR 0064). It names the step a Continue runs as, never the workflow position.
`delegation/provision-step-identity.test.ts`, `workflows/continuation-tools.test.ts` and
`workflows/run/launch-read-resolver.test.ts` cover every row except the `resume`-cursor row.

### Governed delegation controls (D1)

The `restrictCrossSessionMessaging` doc comment in `core/agent-runner.ts` says what a governed
session is and what its launch turns off. The same row of each runner's `*_SPEC_SUPPORT` (`runners/<id>/spec-support.ts`) names
that runner's control. The D1 entries in `PARITY_EXEMPTIONS` name, for each runner without a
control, the reason and the version inspected. The Owned workers part of `README.md` states
the limits that a user meets, and § 11 of
`.ai/specs/2026-10-27-task-communication-protocol.md` holds the probe evidence.

A control adds no tool grant and writes no harness configuration file. The controls are
cooperative same-user supervision, not isolation.

### Native cross-session messaging at shipped defaults (D3)

A runner's native cross-session messages bypass Squawk's recorded conversations, so Squawk tasks
talk through `hsq message`. The "Messaging other tasks" text of `handoffInstructions`
(`packages/cezar/src/handoff.ts`) tells every session so. The D3 cells and the D3 entries in
`PARITY_EXEMPTIONS` hold each runner's control at shipped defaults; § 11 of the same spec
holds the probe evidence.

Squawk changes no MCP server, plugin or tool setting of the user.

<a id="codex-retrying-stream-errors-550"></a>

### Codex retrying stream errors

`runners/codex/codex-startup.test.ts` holds the retry rules, and
`runners/codex/__fixtures__/stream-retry.md` records the probe.

---

## 8. The golden-fixture testing contract

`packages/cezar/src/runners/<id>/__fixtures__/` holds pairs: `<name>.ndjson` is the
backend's wire output, and `<name>.expected.json` is the exact `UiEvent[]` that its mapper
must produce. `<backend>-ui-mapper.test.ts` replays each pair the way the runner drives the
mapper. §6 reads the same expected files.

- Take every fixture from the upstream wire: a live capture, or the upstream schema or
  source. Never encode a shape that you assume.
- Cite the upstream source and version in the fixture directory's `README.md`. Label each
  constructed frame as constructed, and say what you could not run live.

## 9. Persistence & transport

Each run has one append-only NDJSON event file that holds v1 and v2 events together
(`docs/areas/runs-store.md`). Never rewrite, reorder or renumber it. The per-run SSE route
replays it, then streams live, under the event names `run-event` (v1) and `ui-event` (v2).
The multiplex route has its own envelope: `packages/cezar/src/server/live-routes.ts` holds
it. A Squawk-owned event such as
`provider-auth-required` never carries vendor error text or credentials.

---

<a id="10-adding-a-new-runner-the-387-pi-checklist"></a>

## 10. Adding a new runner (the open-mercato/cezar#387 `pi` checklist)

A runner is one definition in its own folder, which one call registers
([ADR 0067](docs/adr/0067-register-each-runner-as-one-definition.md)). A new built-in runner
changes these places and no other file, with one exception at the end of this section (a new
turn-path fact value also adds a shared unit test):

- **Its folder**, `packages/cezar/src/runners/<id>/`: the definition and its data files, the
  adapter, the mapper, the catalogs, the test data files, the fixtures and every test of the
  runner, parity files included. No backend-specific type leaves it.
- **Its scripts** in `packages/cezar/scripts/`: the mock script, its data files (the skill
  captures in `mock-skill-data/<id>.mjs` when it lists skills) and any helper the runner ships.
  They stay there because the packaged CLI tests and the mocks start them by path; the
  definition's `mock` part names the mock script.
- **One line** in `BUILT_IN_RUNNERS` (`runners/built-in.ts`), in display order.
- **Its id** in `BUILT_IN_RUNNER_IDS` (`runners/ids.ts`). `core/runner-registry.test.ts` fails
  when the two lists differ. Only tests, testkits and dev scripts read `runners/ids.ts`.
  `cez/runner-ids-import` fails a production file that names it with a literal path (a static
  import or export, a literal `import()` or `require()`, a type import); a path built from pieces, such as a template literal with a substitution, is outside its static scope.

What a new runner's folder holds:

- `definition.ts` and the data file of each definition part (`docs/areas/runners.md` lists
  them). This includes the `accounts` part's home slot and `homeDir()`, the native files that
  the `configFiles` part lists (a shared file such as the project `AGENTS.md` is read by every
  runner that lists it), the `cli` part's `openTarget`, and the `mock` part's
  `parityExemptions`, `scenarioEnv`, `sessionStore`, `selfSettledApprovalEcho` and
  `missingSession`;
- `session-wire.testkit.ts`, which says how the mock's recorded wire shows a session, a turn, its
  effort, prompts, steers, the system prompt and skill triggers, and `ui-mapper-row.testkit.ts`,
  the runner's row of the mapper robustness test, and its thin wrappers:
  `ui-mapper-robustness.test.ts` calls `describeUiMapperRobustness('<id>', "hostile")`;
  `ui-mapper-robustness-mutations-<part>.test.ts` calls the same shared testkit for each
  numeric part returned by `robustnessParts('<id>')`: up to four groups, capped by fixture
  count. They split the sorted fixtures by index modulo the number of groups;
- `__fixtures__/golden.json`, the runner's own expected values for tests outside its code (the
  keys are in `core/runner-golden.testkit.ts`), and the golden wire fixtures;
- the per-runner parity files (`harness-<id>-*`, `waits-<id>-*`, `automation-tools-<id>-*`,
  `runner-skill-trigger-<id>-*`).

The guard tests read these from the folder and fail with a message that names a missing piece.
The parity test kits branch on a runner's declared facts and data in the cells that
hearsay-tools/squawk#3997 migrated; the cells that still branch on a runner id (D1, R35) are
hearsay-tools/squawk#3998. `.ai/scripts/simulate-sixth-runner.mjs` proves the list in a scratch
clone, and its header gives the exit check. Its default mode adds an incomplete runner in the four
places: the typecheck passes, and the printed test files fail only by naming a missing piece in
the runner's folder, plus `FACT_VALUE_TESTS` for a new turn-path fact value. `--complete` copies a
real runner's folder and scripts under a new id: the typecheck passes and every printed test file
passes. An outside runner
(roadmap step 4) only calls `registerRunner`. `runners/fixture/` is the smallest example: its
test registers it, runs a task and runs the parity kit on it. The items below say what goes in
the folder, and the rules that the guards do not force, or force only in part. The item numbers
are stable.

1. **Runner** — `<id>-runner.ts` implements `AgentRunner` / `AgentSession`. Declare its spec
   support (`spec-support.ts`) and its facts (`facts.ts`) from what the wire does, not from a
   similar runner. Probe mid-turn input live for `inputDelivery`. Probe a resumed session for
   `systemPromptOnResume`; when you cannot, declare `resent`. A wire that can raise a
   permission request after its turn ended declares `nativePermission: 'after-turn'` and
   implements `AgentSession.endWhenQuiet`; the late-permission parity cells check both. Use
   `prependSystemPrompt` when the backend has no system-prompt channel. For a fork of an
   existing runner's wire, read the fork's own protocol documents for the turn boundary, the
   session id and the tool flags before you copy code.
2. **Definition** — `definition.ts` exports one `defineRunner` value. It imports only types and
   data: the adapter, the catalogs, the login parser and the model settings reader load through
   its `load*()` functions. The adapter imports the runner's data files, never `definition.ts`.
   The parts are in `core/runner-definition.ts`; `docs/areas/runners.md` lists the file of each.
   A runner id is an open string; the server checks a request's id against the registry.
3. **Detection** — the `detection` part (`detection.ts`): the PATH name, the `*_BIN` override,
   what dry-run reports and the hints. Core runs the probe. An absent CLI never fails the boot.
4. **Mapper** — `<id>-ui-mapper.ts` emits the v2 stream (§4).
5. **v1 alongside v2** — emit v2 through `SessionOptions.onUiEvent` and keep the v1 stream.
6. **Golden fixtures** — `__fixtures__/` in the folder. Follow §8, and cover every §6 capability
   that the wire supports. `__fixtures__/golden.json` holds the values that tests outside the
   runner pin (`core/runner-golden.testkit.ts` lists them).
7. **Parity** — every §6 row passes or carries a named exemption. A wire gap of this runner is an
   entry in its `mock.parityExemptions`: the criterion, its kind and the wire reason, never "not
   implemented yet".
8. **Harness parity** — the `mock` part (`mock.ts`) names the mock script, its `*_BIN` variable,
   the prompt for each scenario it runs and its `askResumeCases`. Make the mock a wire encoder
   over `packages/cezar/scripts/mock-scenario.mjs`; the lint rule `cez/mock-scenario-boundary` fails a
   built-in mock that does not import it. That module owns scenario selection and scripts; the
   mock emits the backend's native frames. The per-runner parity files
   (`harness-<id>-<part>-parity.test.ts`, `waits-<id>-<part>-parity.test.ts`) each register only
   this runner and pass its definition to the kit.
   Choose the ask path: `cezar_ask` alone, or also a native bridge onto `ask.requested`. A
   native bridge keeps its pending request in the session and routes the next human answer
   back through it. A parked native ask idle-closes like a `cezar_ask` park; the close drops
   the pending request, and the answer opens the reopened session as its first message
   (hearsay-tools/squawk#2701, parity R129). It answers a malformed native request with an error and never leaves
   the turn blocked. Each native ask kind that a human can answer needs an entry in
   `askResumeCases`. Prove the Squawk tools as
   [Waits](#ci-wait-tool-contract-474) requires.
9. **Plumbing** — the `configFiles` part (`config-files.ts`) holds the native files that
   Settings → Agent config shows and the runner's `agentConfig` pane. The `cli` part's
   `openTarget` is the runner's "Open in" menu entry (label and icon key); the menu takes the
   binary and its `*_BIN` override from the `detection` part. The `display` part
   (`display.ts`) holds the names, the icon key, the install hint, the login command and the
   account folder example. `GET /api/v1/runners` sends both with the `models.suggested` presets,
   so the cockpit needs no edit. Keep every change additive, so that old run records still
   parse.
10. **Model selection** — the `models` part (`models.ts`): `suggested`, `known`, `retired` and
    the `idMap`, and `models.loadSettings()` for the native default model.
    `core/model-identity.test.ts` holds the rules of the id map.
11. **Host model discovery** — ships in the runner's PR: `<id>-model-catalog.ts` exports
    `discover<Id>Models`, and `loadModelCatalog()` imports it. `model-discovery-guard.test.ts`
    forces the module, the export and the catalog entry for every id in `runners/ids.ts`, or an
    exemption with the wire reason. It does not force these rules. The adapter calls the CLI's own model-listing surface under the runner's child
    environment, with bounds, and throws when it cannot read the model list. It never reads
    the CLI's config or cache files and never runs a model turn. `server/models-api.test.ts`
    holds what a failure may report.
12. **Credentials** — the `env` part (`env.ts`) lists an allow-list prefix for every provider
    that the runner's model ids can name. `buildChildEnv` reads it through the registry. Never
    widen another runner's entry.

A wire gap needs owner review (§6). The shared exemption rows, which select runners by facts or
span every runner but one, stay in the parity kit (§7); a new runner adds no row there. A runner
that declares a value of a turn-path fact (a key of `TURN_PATH_FACTS`) that no runner declared
before also adds a unit test of the shared code for that value to `FACT_VALUE_TESTS`
(`core/parity-classes.testkit.ts`); that table is keyed by value, not by runner, so it is no
roster list.

<a id="10a-removing-a-runner"></a>

## 10a. Removing a runner

Saved runs outlive the runner they ran on. A run saved on a removed runner still opens, lists,
shows its transcript and can Continue on another runner (hearsay-tools/squawk#3715). A run saved
on a runner that the reading process did not register (a runner of a newer build, or one that did
not load) reads the same way, but the fold is undone: the next write keeps its runner, sessions
and step settings, and a process that registers the runner reads it as before. A queued run on
such a runner stays queued and untouched (hearsay-tools/squawk#3897). Most
readers of a saved runner id read the `runner`, `backend` or `removedRunner` field of any value,
so a text search for the id does not find them. Run
`node scripts/readers.mjs --runner <id>`: it lists the readers below, checks that each still
holds its anchor, and adds every quoted use of the id.

1. **Fold** — add the id to `REMOVED_RUNNER_IDS` in
   `packages/cezar/src/runs/legacy-run-rows.ts`. That file folds the saved data at read time:
   the run row with its steps and `workflowDef` steps (`upgradeRemovedRunner`), the stored
   list summary (`upgradeRemovedRunnerSummary`) and the worker-result snapshot
   (`upgradeRemovedRunnerResult`). The fold of a retired id is stored by the next write.
2. **Load sites of the fold** — `packages/cezar/src/runs/store.ts` (run rows and worker
   results) and `packages/cezar/src/runs/run-summary-page.ts` (stored summaries).
3. **Record schema** — `packages/contract/src/runs.ts` keeps `removedRunner` and the step's
   `removedBackend`; `runner` and `backend` are open strings. The store reads a legacy or
   registered id, and any id in a process that registered no runner (`readableSavedRunner` in
   `legacy-run-rows.ts`).
4. **Session selection** — `latestSession` and `removedRunnerStepAfter` in
   `packages/contract/src/run-predicates.ts` choose the session for terminal hand-off and
   Continue. The usage-limit account hold reads the next turn's account through them
   (`packages/cezar/src/workflows/execution-account.ts`).
5. **Queued and interrupted runs** — `packages/cezar/src/workflows/run/queued-revival.ts`
   fails a revived run on a removed runner; `packages/cezar/src/workflows/run-scheduling.ts`
   skips it; `packages/cezar/src/workflows/run.ts` refuses to start or resume it; the queue
   watchdog in `packages/cezar/src/workflows/run/run-line.ts` leaves a run on an unregistered
   runner alone.
6. **Continue** — admission in `packages/cezar/src/workflows/continuation-admission.ts`,
   provenance by start time in `packages/cezar/src/workflows/run/launch-read-resolver.ts`,
   worker identity in `packages/cezar/src/delegation/execution-identity.ts`, and the HTTP
   Continue and checkout routes in `packages/cezar/src/server/server.ts`.
7. **Cockpit** — `packages/web/src/routes/task-thread/run-actions.ts`,
   `packages/web/src/routes/task-thread/run-agent-identity.ts`,
   `packages/web/src/routes/task-thread/continuation-provider.ts` and
   `packages/web/src/routes/task-thread/task-thread.tsx`.
8. **Saved-data tests** — extend `runs/removed-runner-saved-data.test.ts` and
   `workflows/removed-runner-continue.test.ts` with a run saved on the id.
9. **Everything §10 added** — the class, its mapper, fixtures, parity rows, probes, presets,
   model discovery and credential prefixes leave with the runner. Sweep each removed name
   with `node scripts/readers.mjs <name…>`.

A new reader of a saved runner id joins this list and `RUNNER_ID_READERS` in
`scripts/readers.mjs`; `scripts/readers.test.mjs` keeps the two equal.

<a id="11-the-plan-channel-pr-443"></a>

## 11. The plan channel (PR open-mercato/cezar#443)

`plan.updated` is a full replacement (`UiPlanUpdatedEvent`). In a new mapper, find the
backend's real plan channel on its wire: it is not always a todo tool. The mapper tests of
the existing backends hold their channels.

---

## Saved events

Saved runs keep their NDJSON events on disk, so an upgrade must still read every v1
`AgentEvent` `type` string and v2 `UiEvent` dotted type that shipped. A test pins them.

## Related documents

- `docs/areas/runners.md` — how a runner change is tested.
- `.ai/specs/2026-09-04-harness-parity-matrix.md` — design record of the harness parity
  matrix (§7).
- `.ai/specs/2026-07-14-cockpit-ui-redesign.md` and
  `.ai/analysis/cockpit-ui-redesign/agent-event-protocols.md` — design record of protocol
  v2.
- `.ai/specs/2026-10-02-omp-runner.md` and
  `packages/cezar/src/runners/omp/__fixtures__/README.md` — OMP design record and wire
  evidence.
