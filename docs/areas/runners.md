# Agent runners and backends

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`AGENT_PROTOCOL.md` (the contract and the new-runner checklist), then `packages/cezar/src/core/agent-runner.ts`, `packages/cezar/src/core/runner-registry.ts` and the changed backend's `packages/cezar/src/runners/<id>/` folder

## Rules

Shared code outside `packages/cezar/src/core/` and `packages/cezar/src/runners/` reads a runner's declared facts (`RUNNER_FACTS`, `inputDelivery`, `systemPromptOnResume`; `AGENT_PROTOCOL.md` §1) to decide what a runner can do, never a runner id. Every backend implements `AgentRunner`/`AgentSession` and must pass both parity matrices: `ui-parity.test.ts` (mappers) and `harness-parity.test.ts` (runners, including each runner's `specSupport`). Runner prose never counts runners. `HSQ_DRY_RUN=1` (`CEZ_DRY_RUN` fallback) must keep working. The zero-config default includes unrestricted `Bash`, and each runner's `specSupport.toolGrant` says whether its wire honors the list (open-mercato/cezar#430).

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
- **A new runner** declares its facts in `runners/<id>/facts.ts`, its spec support in
  `runners/<id>/spec-support.ts`, its host probe in `runners/<id>/detection.ts`, its terminal
  command and install source in `runners/<id>/cli.ts`, its model data in
  `runners/<id>/models.ts`, its native config files in `runners/<id>/config-files.ts`, its
  native mock script and scenario prompts in `runners/<id>/mock.ts` (the `mock` part), its
  definition in `runners/<id>/definition.ts` and one line in `runners/built-in.ts`; its display
  facts in `runners/<id>/display.ts`, which `GET /api/v1/runners` sends with the `models.suggested`
  and `models.retired` ids and the `agentConfig` pane of its `configFiles` part. The cockpit holds
  no table keyed by runner id: the runner picker's label and line, the model presets, the install
  hint, the login command, the account folder example, the icon key and the Agent config pane are
  all in the definition (hearsay-tools/squawk#3898). `display.icon` is a key of the cockpit's icon
  set (`OPEN_IN_ICONS` in `components/open-in-menu.tsx`, keyed by icon key, not by runner id); the
  generic runner icon is `bot`. A runner's `login.installHint` (the server's message) and
  `display.installHint` (the accounts pane) are different strings. When it adds a value
  that no runner declared before, it also adds that value's unit tests to
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
production code never imports it (`cez/runner-ids-import`). The
testkits it reaches import a kit's `-core` file, never `runners/built-in.ts`, another runner's
definition or a kit's plain name (`fixture-cleanup`, `worker-wait`, `harness-parity`,
`workflow-parity`), which chooses every adapter. A wait parity file also loads the Claude
adapter for its workers, and an owned-workflows file the next runner for R14's mixed chain. `core/runner-closure.test.ts` enforces this
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
`AgentRunner` seam with five built-in backends:

| Backend | CLI | How Squawk drives it | Tool access |
|---|---|---|---|
| **Claude Code** (default) | [`claude`](https://github.com/anthropics/claude-code) | Headless `stream-json` mode. | Per-tool `--allowedTools` (`bashAllowlist` scopes `Bash`); an empty `allowedTools` sends `--tools ""`, which removes every built-in tool, and pre-approves Squawk's own tools (other MCP tools follow the permission mode); `dontAsk` denies unapproved tools without prompting (`HSQ_APPROVAL_GATE=1` (`CEZ_APPROVAL_GATE` fallback) → `acceptEdits` + approval UI; `HSQ_CLAUDE_PERMISSION_MODE=bypass` (`CEZ_CLAUDE_PERMISSION_MODE` fallback) → `--dangerously-skip-permissions`). |
| **Codex** | [`codex`](https://github.com/openai/codex) | `codex app-server` — JSON-RPC over stdio, the same transport the Codex IDE extensions use. | Ignores `allowedTools`; inherits managed permissions and Codex approval defaults. Confirmed unmanaged sessions use `danger-full-access`. `HSQ_CODEX_NETWORK=0` (`CEZ_CODEX_NETWORK` fallback) requires network restriction: unmanaged sessions use network-blocked `workspace-write`; managed filesystem rules remain intact, and an unconfirmed network restriction stops before any turn. If requirements discovery is unavailable, Codex permission defaults apply. |
| **OpenCode** _(experimental)_ | [`opencode`](https://opencode.ai) | `opencode serve` — a local HTTP server with an SSE event stream. | Ignores `allowedTools` entirely; OpenCode's own permission config governs. Squawk answers OpenCode's built-in asks (outside-worktree reads, `.env` reads, the repeated-call guard) once, unless your config has a rule for that permission. Any other ask shows a permission card in the cockpit, and the run waits for your answer. |
| **pi** _(experimental)_ | [`pi`](https://github.com/badlogic/pi-mono) | Persistent `--mode rpc` over JSONL; models are picked with the `provider/model` convention. | Maps `allowedTools` onto pi tool names. The default list, which adds the harness extras `Subagent`, `SubagentSupervisor` and `SubagentWait`, sends no allowlist: `--no-builtin-tools` plus a bundled extension that activates those built-ins, so MCP servers (`direct`, `codemode` and `deferred` exposure) and other pi extensions' tools stay callable. The six base tools alone, the list a worker inherits from a Claude parent, take the same path. A narrowed `allowedTools`, or one that names any tool outside that default set (an `mcp__` tool, `WebFetch` or a custom tool), uses pi's `--tools` allowlist, so a step that grants named tools reaches only those; a list that maps to nothing becomes `--no-tools` (or only the Squawk tools). A configured `bashAllowlist` disables Bash because pi cannot express command-prefix rules. |
| **OMP** _(experimental)_ | [`omp`](https://github.com/can1357/oh-my-pi) | Persistent `--mode rpc` over JSONL (Oh My Pi, a pi fork); models use the `provider/model` convention and are discovered from `omp models --json`. | Maps `allowedTools` onto OMP's `--tools` allowlist (`[]` becomes `--no-tools`); default sessions also pass `todo`, `lsp`, `ast_edit`, `task` and `wait`. A configured `bashAllowlist` disables `bash` because OMP cannot express command-prefix rules. `--tools` filters built-in tools only, so MCP and extension tools stay callable under a narrowed list. |

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
