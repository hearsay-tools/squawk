# Agent runners and backends

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`AGENT_PROTOCOL.md` (the contract and the new-runner checklist), then `packages/cezar/src/core/agent-runner.ts`, `packages/cezar/src/core/runner-registry.ts` and the changed backend's `packages/cezar/src/runners/<id>/` folder

## Rules

Shared code outside `packages/cezar/src/core/` and `packages/cezar/src/runners/` reads a runner's declared facts (`RUNNER_FACTS`, `inputDelivery`, `systemPromptOnResume`; `AGENT_PROTOCOL.md` §1) to decide what a runner can do, never a runner id. Every backend implements `AgentRunner`/`AgentSession` and must pass both parity matrices: `ui-parity.test.ts` (mappers) and `harness-parity.test.ts` (runners, including each runner's `specSupport`). Runner prose never counts runners. `HSQ_DRY_RUN=1` (`CEZ_DRY_RUN` fallback) must keep working. The zero-config default includes unrestricted `Bash`, and each runner's `specSupport.toolGrant` says whether its wire honors the list (open-mercato/cezar#430).

Explicit-shutdown parity reads the declared `shutdownDescendants` scope: `process-group` retains
the detached-survivor checks, while `observed-tree` requires observed detached children to die
after Stop, end escalation and EOF exit after end (S27/S28/S30). It makes no wider claim
about abrupt leader exits before a snapshot (S31). Antigravity declares `observed-tree`.

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
| `login`, `loadLogin()` | `login.ts`, `login-probe.ts` | The status and login arguments, the install hint and the status parser |
| `accounts` | `accounts.ts`; `homeDir()` in `definition.ts` | The account folder layout, the profile markers and the home slot (its key in `AgentHomePaths`, which `agentHomePaths()` in `paths.ts` builds from the registered runners). `homeDir(env, userHome)` resolves the runner's default home |
| `env` | `env.ts` | The environment allow-list prefixes |
| `models` | `models.ts`; `loadSettings()` in `definition.ts` | `suggested` (picker presets), `known` (conflict check), `retired` and the `idMap`. `loadSettings()` reads the native default model; most built-in runners load it from `agent-config/model-settings/<id>.ts`, outside their folder |
| `loadModelCatalog()` | `<id>-model-catalog.ts` | The host model discovery adapter |
| `loadSkillCatalog()` | `<id>-skill-catalog.ts` | The native skill list adapter |
| `configFiles` | `config-files.ts` | The native files that Settings → Agent config shows, and the runner's `agentConfig` pane. A file's readers are the registered runners that list it, so a shared file (`PROJECT_AGENTS_FILE`, `runners/project-agents-file.ts`) names no runner |
| `extraTools` | `extra-tools.ts` | Tools added to the default list when a step sets no `allowedTools` |
| `mock` | `mock.ts` | The mock script in `packages/cezar/scripts/`, its `*_BIN` variable, the scenario prompts, `askResumeCases`, `parityExemptions` (the parity cells this runner's wire cannot carry; A9 exactly where `facts.nativeAsk` is not `answerable`), `scenarioEnv` (the env a scenario sets for this mock), `sessionStore`, `selfSettledApprovalEcho` and `missingSession` |
| `display` | `display.ts` | The display name, the model list name, the model id scope, the picker label and line, the icon key, the install hint, the login command and the account folder example |
| `loadAdapter()` | `<id>-runner.ts` (or the adapter's own name) | The `AgentRunner` class |

The folder also holds the runner's test data: `session-wire.testkit.ts` (how the mock's recorded
wire shows a session, its prompts, steers, system prompt and skill triggers), `ui-mapper-row.testkit.ts` (its row of the mapper robustness test)
and `__fixtures__/golden.json` (values that tests outside the runner pin). `runnerDataRows`
(`core/runner-data-rows.testkit.ts`) imports a per-runner data module, `runners/<id>/<file>`,
for each id in `runners/ids.ts`: facts, extra tools, the mock part, the session wire and the
mapper rows. `runnerGolden` (`core/runner-golden.testkit.ts`) reads one runner's
`__fixtures__/golden.json` as a file. The session-wire and golden readers name the missing file
when a runner has none.

The definition has no tool-injection part. OpenCode's tool server setup is OpenCode code
(`ciOpenCodeEnv` in `runners/opencode/opencode-runtime-config.ts`).

### The registry

`core/runner-registry.ts` holds the registered definitions in registration order.

- `registerRunner(definition)` adds one. A different definition with a registered id is an error,
  and so is a legacy id (`claude-cli`, in `core/runner-ids.ts`). The same object registered twice
  is a no-op.
- `runnerDefinition(id)`, `registeredRunners()` and `isRegisteredRunner(id)` throw on an empty
  registry, so a process entry that registered nothing fails at once. `knownRunnerIds()` and
  `savedRunnerRegistration(id)` never throw: config decoders and the read of saved runs use them.
- `createRunner(id)` is async. It maps a legacy id, gives the default runner (`claude`) to an id
  that no runner registered, and awaits the definition's `loadAdapter()`. After the await, a
  caller checks stop and cancel again before it changes state.
- `src/index.ts` calls `registerBuiltInRunners()` (`runners/built-in.ts`) before any command
  reads config or runs a task. `index-runners.test.ts` pins it. A script under
  `packages/cezar/scripts/` that reads runner data calls it too.
- `BUILT_IN_RUNNERS` (`runners/built-in.ts`) is the only list of built-in definitions.
  `BUILT_IN_RUNNER_IDS` (`runners/ids.ts`) repeats the ids as plain data for tests, testkits,
  `vitest.setup.ts` and dev scripts. `core/runner-registry.test.ts` holds the two lists equal, and
  `cez/runner-ids-import` fails a production file that names `runners/ids.ts` with a literal path
  (a static import or export, a literal `import()` or `require()`, a type import); a path built from pieces, such as a template literal with a substitution, is outside its static scope. The lint rules
  `cez/runner-id-branch` and `cez/runner-roster-literal` read the ids from `runners/built-in.ts`.
- No core file imports a runner file (`cez/layer-import`). A runner class is built only inside its
  own folder (`runner-class-outside-factory`).

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
- A process that registered no runner still maps a legacy id and folds a retired id. It reads
  any other saved id as written, with no fold.
- The stored-config decoders (`config.ts`, `workspace/config.ts`,
  `workspace/agent-accounts.ts`) check ids against the registry. A per-runner record keeps its own
  handling of a key that no runner registered: `defaultModels` in `config.ts` drops it;
  `agentDefaults.models` and the account selections (`registeredRunnerRecord`) keep it and ignore
  it. A single id drops it: `agentDefaults.runner`, `disabledProviders` and an account row's
  `provider`. The next write stores what the decoder read, so a runner that did not register
  loses those settings.

### How tests register runners

No setup file registers every runner. A test registers the runners it drives with
`registerRunner(definition)`. A test that needs every built-in runner (it enumerates
`runnersWhere` or `registeredRunners`) imports `core/register-all-runners.testkit.ts`. A test that
needs only the ids reads `runners/ids.ts`, which loads no definition. A static test table that
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
  shared row runs on one runner, `SCENARIO_RUNNER` (claude), as
  [ADR 0063](../adr/0063-one-scenario-runner.md) records. Shared code sees a
  runner through its turn-path facts (`inputDelivery.mode`, `.consumption`,
  `.acknowledgement`, `.humanInputAtTurnEnd` and `systemPromptOnResume`). The
  scenario runner shows one value of each. Every other declared value names the
  unit tests that drive shared code with it, in `FACT_VALUE_TESTS`. A fix whose
  behavior depends on such a value adds or extends one of those unit tests.
- **A new runner** adds what `AGENT_PROTOCOL.md` §10 lists: its folder, its scripts in
  `packages/cezar/scripts/`, one line in `runners/built-in.ts` and its id in `runners/ids.ts`. [Runner definitions](#runner-definitions)
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
`core/register-all-runners.testkit.ts`, the one test module that calls `registerBuiltInRunners()`;
`core/every-runner.testkit.ts` is that module plus `created-runners.testkit.ts`. A test that
needs only the ids reads `BUILT_IN_RUNNER_IDS` from `runners/ids.ts`, which loads no definition;
production code never imports it (`cez/runner-ids-import`, for literal paths). The
testkits it reaches import a kit's `-core` file, never `runners/built-in.ts`, another runner's
definition or a kit's plain name (`fixture-cleanup`, `worker-wait`, `harness-parity`,
`workflow-parity`), which chooses every adapter. A wait parity file also loads the Claude
adapter for its workers, and an owned-workflows file exactly one other runner for R14's mixed
chain. `core/runner-closure.test.ts` enforces this
(hearsay-tools/cezarion#2939).

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
`WAIT_FOLDS` in `workflows/waits-parity-catalog.testkit.ts` groups the parts of each runner
other than the scenario runner into files of about 3–12 s locally.
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
| **pi** _(experimental)_ | [`pi`](https://github.com/badlogic/pi-mono) | Persistent `--mode rpc` over JSONL; models are picked with the `provider/model` convention. | Maps `allowedTools` onto pi tool names. The default list, which adds the harness extras `Subagent`, `SubagentSupervisor` and `SubagentWait`, sends no allowlist: `--no-builtin-tools` plus a bundled extension that activates those built-ins, so MCP servers (`direct`, `codemode` and `deferred` exposure) and other pi extensions' tools stay callable. The six base tools alone, the list a worker inherits from a Claude parent, take the same path. A narrowed `allowedTools`, or one that names any tool outside that default set (an `mcp__` tool, `WebFetch` or a custom tool), uses pi's `--tools` allowlist, so a step that grants named tools reaches only those; a list that maps to nothing becomes `--no-tools` (or only the Squawk tools). A configured `bashAllowlist` disables Bash because pi cannot express command-prefix rules. |
| **OMP** _(experimental)_ | [`omp`](https://github.com/can1357/oh-my-pi) | Persistent `--mode rpc` over JSONL (Oh My Pi, a pi fork); models use the `provider/model` convention and are discovered from `omp models --json`. | Maps `allowedTools` onto OMP's `--tools` allowlist (`[]` becomes `--no-tools`); default sessions also pass `todo`, `lsp`, `ast_edit`, `task` and `wait`. A configured `bashAllowlist` disables `bash` because OMP cannot express command-prefix rules. `--tools` filters built-in tools only, so MCP and extension tools stay callable under a narrowed list. |
| **Antigravity** | `agy` from the [ACP registry archive](https://antigravity.google) | `agy --uid=` over ACP stdio, using the shared ACP layer. No interactive terminal handoff. | Native permission requests follow the task grant and Bash prefixes. Granted requests proceed; ungranted requests fail, or reach the approval card with `HSQ_APPROVAL_GATE=1`. Client reads require Read. Native `interaction_` asks always reach the question card. See [Antigravity tool access](#antigravity-tool-access). |

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

Antigravity ACP 1.5.0 runs in `default` mode on every fresh or resumed session. Squawk
answers native permission requests from the tool grant and Bash command prefixes. Granted
requests proceed; ungranted requests fail. With `HSQ_APPROVAL_GATE=1`, ungranted requests
reach the native approval card instead. This matches Claude's approval gate. Native
`interaction_` questions always reach the question card. Client file reads require Read;
they cannot request interactive approval. The wire's `ask_question`, `schedule`, and `finish`
need no tool admission. Read/search built-ins that have no separate native tool are not invented.
Squawk loads its lifecycle MCP server eagerly and disables only agy's native `run_workflow`
on new and resumed sessions. Squawk owns workflows; the native tool would also write its
built-in skill into the task checkout. Native `start_subagent` stays available. Squawk sends
only the task checkout as a workspace, because agy sorts workspace roots to choose the shell
cwd. Absolute handoff and temp paths remain usable through shell tools. Native option
questions allow only the offered answers; unsupported option counts cancel with a notice.
See [the recorded wire](../runners/antigravity-wire.md).


Antigravity status reports credential presence. It checks `GEMINI_API_KEY` or `GOOGLE_API_KEY`,
or a stored OAuth sign-in under `GEMINI_HOME` (default `~/.gemini`) with the harness credential
file present. It does not validate a key with the model API. Credential file contents stay unread.
