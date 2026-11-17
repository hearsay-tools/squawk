# Runner-native skills: implementation plan
Status: active

Plan for [the runner-native skills spec](2026-11-16-runner-native-skills.md). The spec holds the
design and the owner's decisions D1 and D3 to D8; this file says how the work is cut and what
each slice changes. Baseline: `main` at `6674cbeda`, after the Cursor removal
(hearsay-tools/squawk#3725). The probe reports are in
[`.ai/analysis/2026-11-16-runner-native-skills/`](../analysis/2026-11-16-runner-native-skills/).

Seven slices, one pull request each. Slice 3 is cut in two (3a and 3b) after the check against `main` at `caf0e3eaa`. Delete this file when slice 5 merges.

## Order

| Slice | Starts after | Why |
| --- | --- | --- |
| 1. List seam | now | It adds code that nothing reads yet |
| 4. Automation tool | now | It touches the tool server, not the runner adapters |
| R. This repository's skills | now | It changes repository files only |
| 2. Trigger seam | slice 1 | Both edit the five adapter files and the mock wires |
| 3a. Switch the server and run path | slices 2 and R | It needs both seams, and it stops reading `.ai/skills/` |
| 3b. Switch the cockpit | slice 3a | It reads the route that 3a adds, and removes the old routes |
| 5. Removal | slices 3b and 4 | It deletes what slice 3 stops using and the built-in skill that slice 4 replaces |

The five adapter files (`packages/cezar/src/core/{claude-cli,codex-app-server,opencode-server,pi,omp}-runner.ts`),
the mock wires in `packages/cezar/scripts/` and `core/runner-facts.ts` are hot files for slices
1 and 2. `workflows/run/` is a hot area for slices 3a and 5; `packages/web/src` for 3b and 5. Slices do not stack: each one lands
on `main` before the next one that shares a hot file starts.

## Rules for every slice

- A slice that adds a runner capability ships its parity rows in the same pull request, on the
  native mock wires through `HARNESS_ADAPTERS` ([runners](../../docs/areas/runners.md)). Extend
  the mock (`mock-claude.mjs`, `mock-codex-app-server.mjs`, `mock-opencode-serve.mjs`,
  `mock-pi-rpc.mjs`, `mock-omp-rpc.mjs`) to answer as the probe report for that runner records.
  Where a mock gains a new frame, first capture that frame from the real CLI, as the probes
  did, and keep the capture in `core/__fixtures__/<runner>/`. Build the mock's answer from the
  capture. `record-mock-wires.mjs` records mock traffic only; it is not evidence of what the
  real CLI sends.
- Shared code outside `packages/cezar/src/core/` reads a declared fact, never a runner id.
- Each "open check" below is a short probe against the real CLI. Its result goes into the
  runner's report in the analysis folder, in the same pull request.
- Every slice follows the reader sweep in
  [CODE_REVIEW.md](../../CODE_REVIEW.md#changing-working-behavior) for each shared name it
  changes.
- No alias, fallback or deprecation window. Saved data still opens (see slice 5).

## Slice 1: list seam

**Goal:** Squawk can ask each of the five runners for its skills, for one folder and one
account home, without a model call. Nothing in the product reads the answer yet.

**Shape.** Follow the model catalog, which already solves the same problem:
`core/runner-model-catalog.ts` (cache, in-flight join, failure reason),
`core/host-model-catalog.ts` (one adapter for each runner) and `core/<runner>-model-catalog.ts`.

- Contract, `packages/contract/src/runner-skills.ts`: `runnerSkillSchema`
  `{ id, name, description?, scope?, plugin?, path? }` and the list answer
  `{ runner, skills, problems, source: 'live' | 'cache' | 'unavailable', reason? }`.
  `scope` is `'repo' | 'user' | 'system' | 'other'`, mapped by each adapter. D8 needs it.
- `core/runner-skill-catalog.ts`: the cache. Its key is runner, account home and folder. It
  joins concurrent reads, bounds each probe with a timeout, and keeps the last good list with
  a failure reason, as the model catalog does.
- `core/<runner>-skill-catalog.ts`, one for each runner, with the route the probe tested:

  | Runner | Route | Notes from the probe |
  | --- | --- | --- |
  | Claude | `get_skills_dialog` control request to a short `claude` process with `--settings '{"disableAllHooks":true}'` and `--no-session-persistence --strict-mcp-config --mcp-config '{"mcpServers":{}}'` | No path in the answer. `--bare` and `--safe-mode` list nothing |
  | Codex | `skills/list` with `cwds`, after `initialize`, no thread | Reuse `codex-app-server-transport.ts` as `codex-model-catalog.ts` does. Map `errors` to `problems`. One id can come twice |
  | OpenCode | `GET /skill?directory=` | No scope field: derive it from `location`. The server caches its list. Drop entries under a `.trash` folder |
  | pi | RPC `get_commands` to `pi --mode rpc --no-session` | Launch with `pi-project-skills.mjs` exactly as `pi-runner.ts` does, or project skills are missing. Strip the `skill:` prefix from the id |
  | omp | `omp skill list --json` | Works without a login. Map `warnings` to `problems`. Map `source` (`provider:level`) to scope |

- The account home goes to the probe through `profileEnv` (`core/agent-profiles.ts`), the same
  way a session gets it.
- This slice declares no runner fact. The three skill facts describe the trigger, so slice 2
  declares them, and slice 3 registers them as turn-path facts with their tests.

**Tests.** One unit test file for each adapter against recorded answers, as the model catalog
adapters have. One parity family, class `every-runner`: the list through each native mock wire
returns a project skill, a user skill and, where the runner has them, a plugin skill and a
problem.

**Open checks to close here.**

- Claude: whether the user's MCP servers start during a list call, and whether hooks from
  managed policy run despite `disableAllHooks`.
- Codex: a list call with a fresh home writes state files into that home. Decide whether the
  probe may run against an account home that Squawk manages.
- Codex: whether a symlinked mirror of a skill folder is listed as a second entry (D8).
- omp: `OMP_PROFILE` against the real omp root.

**Done when** each adapter lists through its mock wire and against the real CLI, a failed or
slow probe answers `unavailable` with a reason inside the timeout, and no probe leaves a
process behind.

## Slice 2: trigger seam

**Goal:** an adapter can open a turn with a named skill, and report whether it resumed.

- `AgentRunSpec.skill?: { id, path?, args }` in `core/agent-runner.ts`, with a row in each
  runner's `specSupport`.
- A `skill` variant of `ContentBlock`, valid only as the first block of a message, for a
  trigger in a later turn (D3). `sendMessage` carries it.
- The forms and their rules are the table in
  [the spec's runner seam](2026-11-16-runner-native-skills.md#the-runner-seam). In short:
  Claude puts the opening context in an earlier text block and `/id args` in the last one;
  Codex sends the structured item with the listed path on `turn/start` only; OpenCode posts
  the command and does not wait for the answer; pi and omp send `/skill:id args`, and pi
  always gets an argument on the same line.
- OpenCode: the adapter treats the user message with the skill body on the event stream as the
  acknowledgement. A turn can run past 300 s, so the adapter must not hold the command request
  open for its result (`opencode.md`, round 2, B1 and B2).
- omp: map the `custom` message with `customType: "skill-prompt"` to a user-message event that
  names the skill and its arguments. Today `omp-runner.ts` drops it.
- Resume report: the `session` event gains `resumed: boolean`. OpenCode already knows it
  (`bootstrap` in `opencode-server-runner.ts`); the other adapters report what they did.
- Codex: a trigger never goes through `turn/steer`, and never through a `turn/start` during an
  active turn. The adapter refuses such a send; slice 3 holds the message instead (D6).
- Facts in `RunnerFacts` and `RUNNER_FACTS` (`core/runner-facts.ts`): `skillTriggerMidTurn`
  (true for pi and omp after the open check below), `skillUnknownName` (`'error'` for
  OpenCode, `'silent'` for the rest) and `skillsSeenBySession` (`'live'` for Codex,
  `'at-start'` for the rest). Do not add them to `TURN_PATH_FACTS` here:
  `FACT_VALUE_TESTS` is typed over that table, and `parity-classes.test.ts` then demands a
  unit test for every value the scenario runner does not show. No shared code reads the facts
  until slice 3.

**Tests.** Parity rows on every runner: first turn with arguments; first turn with opening
context; a later turn; a resume; an id the runner does not know (the declared
`skillUnknownName` value); for OpenCode, a dropped command request while the turn continues.
Seam contract rows hold each runner to its declared skill facts.

**Open checks to close here.**

- Claude and omp: a trigger in a message during a running turn. Set `skillTriggerMidTurn` from
  the result.
- The layers above the omp adapter on a skill turn: the transcript shows the skill start once.

**Done when** every row passes on the mock wires, and one real turn for each runner returns
the fixture token with no tool call.

## Slice R: this repository's skills

**Goal:** the five skills in `.ai/skills/` (`auto-merge`, `campaign`, `check-code-quality`,
`land-pr`, `om-prepare-test-env`) can be started natively on every runner, before slice 3
stops reading that folder (D5).

- 56 files name `.ai/skills/` paths: `AGENTS.md`, CI scripts, `squeal.config.json`, e2e specs
  and the skills themselves. So the files stay where they are.
- Add tracked links: `.agents/skills/<name>` and `.claude/skills/<name>`, each a relative
  symlink to `../../.ai/skills/<name>`. `.agents/skills` covers Codex, OpenCode, pi and omp;
  `.claude/skills` covers Claude.
- `om-prepare-test-env/SKILL.md` has no frontmatter. The Codex, pi and OpenCode probes show
  that such a file is not listed as a skill. Add `name` and `description`. Leave its body as
  it is.
- `.gitignore` ignores `.agents/` and `.claude/skills` today. Change it to ignore their
  contents except these five entries.
- Check first, on each runner, that a symlinked skill folder inside the project is listed and
  starts. Codex is tested (`codex.md`: listed with the resolved path). When a runner does not
  list a link, move that skill's files into the native folder and leave the link at the old
  path instead.
- A test in `.github/scripts/` holds the two link sets equal to the folders in `.ai/skills/`.

**Done when** each of the five runners lists the five skills in a fresh task worktree.

## Slice 3: switch

**Goal:** every reader uses the runner's list and the native trigger. This is the breaking
change. It lands as two pull requests, each with `!` in its title:

- **3a, server and run path.** Every bullet under "Server and run path" below, the tests
  except the two e2e rewrites, and the prompt-template fix. It adds `GET /runner-skills` next
  to the old routes and leaves them in place, because the cockpit still reads them.
- **3b, cockpit.** Every bullet under "Cockpit" below, the state restore cases, the two e2e
  rewrites, and the removal of `GET /skills`, `GET /skills/importable` and
  `POST /skills/refresh`.

`main` stays usable after 3a. This repository's skills are linked natively since slice R, so
a pick of one of them still starts. A pick of a skill that only Squawk's own catalog held (a
team source, `.ai/cezar/skills`) fails at step open with an error that names the runner, the
account and the paths. That is the intended break. Until 3b lands, the cockpit still shows the
team sources and the switches, and they do nothing; the 3a pull request says so. The reverse
order does not work: a cockpit that sends ids and paths from the runner's list needs a run
path that reads that list.

Server and run path (3a):

- `server/server.ts` and the server setup: create one `RunnerSkillCatalog`
  (`core/runner-skill-catalog.ts`, with `core/host-skill-catalog.ts`) for the server, and map
  the account to its `accountHome` as a session does. Today no product code creates one. Its
  cache keeps a list for 300 s; `refresh=1` drops the entry first.

- `workflows/run/step-session.ts`: at step open, read the list for the step's runner, account
  and folder; resolve the reference (`{ id, path? }`, D8 for a duplicate id); fail the step
  before any model call when the id is missing or ambiguous; set `spec.skill`. Send no skill
  body in the system prompt.
- The chosen copy travels with the task (D8). Only the inline `steps` of `POST /runs`
  (`packages/contract/src/runs.ts`) and the stored run step gain an optional `skillPath` next
  to `skill`. `workflowStepDefSchema` (`packages/contract/src/workflows.ts`) does not: it also
  feeds the workflow file schema (`workflow-file.ts`), automation storage
  (`automation-storage.ts`) and the workflow save and parse bodies, and none of those may hold
  a path. The cockpit (3b) sets it on the inline step when the picked entry has a path. The run
  record keeps the step, so a later step open, a recovery and a fresh-session Continue start
  the same copy.
- The picker lists the project folder, and the step runs in a task worktree. A skill inside
  the project has another absolute path there. So `skillPath` is relative to the listed folder
  when the skill lies inside it, and absolute otherwise (a user or system skill). The server
  makes it relative when it answers the list, with the folder it listed. At step open Squawk
  resolves a relative `skillPath` against the step's working folder, then compares it with the
  paths in that folder's list. A path is specific to one host, so nothing portable holds one: the workflow
  builder writes no `skillPath` into a saved workflow file, and an automation definition,
  `worker spawn --skill` and the task CLI's `--skill` name a skill by id. For those, the D8
  scope rule decides. A `skillPath` that the list no longer holds fails the step at step open.
- `task-cli/cli.ts` (`start`): it reads `/skills?wait=1` today and warns that the run "may use
  the plain prompt". Read `/runner-skills` for the run's runner and account. A missing id now
  fails the step, so the warning says that.
- `workflows/run/launch-context.ts` (`sessionContextFor`): stop dropping the opening context
  for a slash opening. The adapter now places it.
- `workflows/run/continuation-session.ts` and `launch-read-resolver.ts`: a Continue that
  resumed sends no trigger; one that opens a fresh session sends the step's trigger again.
  Shared code cannot wait for the `session` event's `resumed` before it chooses the opening
  message: OpenCode's `bootstrap` decides, emits the event and posts the opening in one call,
  and Claude learns it from the CLI's own report after the start. Add a spec field, for example `resumeFallbackSkill`, with a
  row in each `specSupport`: the adapter sends it only when it opens a fresh session, as
  OpenCode does with `resumeFallbackSystemPrompt` (`agent-runner.ts`). The `resumed` event
  stays as the record of what happened. `skipSkillOnResume` goes away with the skill prefix.
- `workflows/active-run.ts` and `workflows/run/run-skills.ts`: the session keeps the ids, paths and scopes
  it read when its runner process started. Later triggers are checked against that list, or
  against a fresh read when the fact says `live`.
- `workflows/run/input-delivery.ts`: a leading `/name` that is in the session's list becomes a
  `skill` block (D3). During a running turn the message is held until the turn ends unless
  `skillTriggerMidTurn` is true (D6). An ambiguous name is sent as text with a note (D8).
  Read one fact in each function, as `cez/runner-fact-combination` requires.
- `delegation/service.ts` (`resolveSpawnWorkflow`): check `--skill` against the list of the
  worker's runner and account, not the parent's.
- `planner.ts`: build the catalog from the list of the project's default runner. A proposed
  step with another runner is checked at step open.
- `workflows/run/turn-bookkeeping.ts` (`autoNameRun`): take the description from the session's
  list.
- `workflows/run/compose.ts` also calls `discoverSkills`: move it to the runner's list too.
- omp expands `/skill:<known name>` anywhere in a message, not only at its start. Squawk's D3
  handling reads only a leading `/name`, so on omp a `/skill:` inside a message starts the
  skill natively, without Squawk's list check or a D8 note. Squawk does not intercept it. Add
  an omp parity row that shows it.
- The built-in `create-cezarion-automation` skill: no runner lists it, so a pick of it would
  fail at step open. 3a stops offering and resolving it: drop `builtinSkillsOf(manager)` from
  the list `GET /skills` answers (`server/server.ts`), stop `launch-context.ts` from returning
  `createAutomationSkill`, and drop `skills: ['create-cezarion-automation']` from the "Create
  an automation" template (`packages/web/src/lib/prompt-templates.ts`), whose `skills` field
  only links the template's text to that pick. The `cezar_automation` tool from slice 4
  covers the job. Slice 5 deletes `automations/builtin-skill.ts`.
- Update the AST rule `cez/active-run-skills-write-outside-owner` metadata in
  `packages/cezar/src/lint/active-run-write.ts` when the `ActiveRun` skills group changes.
- D8 names Codex's `admin` scope; the contract maps it to `other`
  (`packages/contract/src/runner-skills.ts`). The resolver treats a copy with scope `other` as
  ambiguous, as D8 says for `admin`.
- `server/server.ts`: add `GET /runner-skills?runner=&account=` with a `refresh=1` query. The
  schema mirror `packages/api-client/src/contract/runner-skills.ts` exists since slice 1; add
  the route and its query schema. 3b removes `GET /skills`, `GET /skills/importable` and
  `POST /skills/refresh`.

Cockpit (3b):

- `routes/skills.tsx`: a read-only inventory for one runner and account, with the runner's own
  problems and a re-read button. Remove `team-sources-panel.tsx`, the switches
  (`lib/use-skill-selection.ts`) and the shadow mark.
- A picked skill is `{ id, path? }`. `TaskSource` (`routes/new-task-form.ts`) is
  `UiState['lastTask']` today, so give the draft and the picked value their own type that
  carries the path, and leave the `ui-state` contract (`contract/src/workspace.ts`) unchanged.
  The draft store (`routes/new-task-draft.ts`) carries the path, and `buildCreateRunBody` sends it as
  `skillPath`. When the list holds one id twice, the picker shows both entries with their
  paths. `lastTask` and `recentSources` in `ui-state.json` keep names only; a recent name that
  matches two entries shows both.
- Pickers read the list of the step's runner and account: `components/composer/`,
  `components/command-palette.tsx`, `routes/new-task*.ts(x)`,
  `routes/workflows/workflows-builder-sections.tsx` (its list is read in
  `routes/workflows/workflows.tsx`), `routes/github/hand-to-agent.tsx` (read in
  `routes/github/use-hand-to-agent-state.ts`) and `routes/settings/prompt-templates-section.tsx`. A list that is
  unavailable still lets the user type an id.
- `components/skill-detail.tsx` shows what the runner reports. Squawk reads no skill file.

**Tests.** Add the three skill facts to `TURN_PATH_FACTS` (`core/parity-classes.testkit.ts`)
together with a `FACT_VALUE_TESTS` entry for each value that the scenario runner does not
show: `skillTriggerMidTurn` true, `skillUnknownName` `'error'` and `skillsSeenBySession`
`'live'`. Shared parity rows for step open (known, missing and ambiguous id), a fresh-session
Continue, a held trigger, a typed name and the omp `/skill:` inside a message (all 3a). 3b: rewrite `packages/web/e2e/settings-skills.e2e.ts`
and `skill-search-ranking.e2e.ts` against a mock runner's list.

### State restore cases

The new-task form restores its draft from the browser's local storage
(`routes/new-task-draft.ts`): the text, the source, the runner and the account. `resolveSource`
keeps a drafted skill only when the catalog still has it. A new form with no draft opens with
no skill; `lastTask` in `ui-state.json` is still written and still preselects nothing. This
slice keeps both rules. What changes is the catalog that the check reads: the list of the
draft's runner and account.

| Path or trigger | Restored value | Displayed value |
| --- | --- | --- |
| Open the form with no draft | Nothing | No skill selected, whatever `lastTask` holds |
| Reopen with a drafted skill that the drafted runner lists | The drafted `{ id, path? }` | The skill, with the runner's description |
| Switch between two projects that each hold a draft | Each project's own draft | Each skill checked against its own runner's list |
| Change the runner or the account in the form to one that does not list the drafted skill | The draft keeps the id | No skill selected. The draft keeps the id, so a change back shows the skill again |
| The drafted `path` is gone and the id is still listed | The draft keeps the id and the path | No skill selected until the user picks again. Squawk does not take another copy of the same name in its place, as at step open |
| The list is unavailable when the form opens | The drafted id | The id, marked unchecked. Step open still checks it |

The form derives the selection from the draft and the current list. It never writes a masked
value back to the draft.

**Done when** (3a) a selected skill starts natively on each runner with no skill text in the
system prompt, a missing id fails before a model call, a fresh-session Continue starts the
step's skill again, and no run-path reader is left on `discoverSkills` (the old `GET /skills`
and `POST /skills/refresh` routes still call it until 3b); (3b) every
cockpit picker and page reads `/runner-skills`, and the three old routes are gone.

## Slice 4: automation tool

**Goal:** a tool in Squawk's own MCP server replaces the built-in `create-cezarion-automation`
skill (D7).

- One new entry in `squawkTools` (`ci-wait/tools.ts`, `ci-wait/tool-catalog.ts`), next to
  `cezar_schedule_task`, behind the same `automationsToolEnabled` gate. Every adapter reads
  that list, so no adapter changes.
- Extend `automations/tool-adapter.ts`: actions to create a repeating automation, show it,
  preview a GitHub poll and enable it. Today the adapter refuses repeating automations on
  purpose (hearsay-tools/cezarion#1465); this slice lifts that for the new tool only.
- The tool enforces what the playbook asked for: a new automation is paused; `enable` needs an
  explicit argument and, for a poll, a preview made in the same session.
- The automations part of the system prompt (`automations/prompts.ts`) names the tool in place
  of the CLI steps. This is agent-facing text: keep every rule the current text holds.
- The built-in skill stays until slice 5.

**Tool cases (slice 4).** The existing one-time tools and CLI retain their behavior.

| Call | Result |
| --- | --- |
| Create repeating poll or schedule | Paused definition and cockpit URL; schedule also reports next occurrence |
| Create with enable/enabled, or a one-time schedule | Invalid request; one-time schedules use their existing tools |
| Enable without explicit true | Refuse before changing state |
| Enable poll before successful preview in this capability | Refuse before changing state |
| Enable poll after preview in a different session, Continue or recovery | Refuse; preview again in the calling session |
| Enable after definition edit or failed preview | Refuse; successful preview must name the current revision |
| Preview GitHub poll | Existing scheduler in preview mode, without a launcher; return match count and truncation |
| Enable repeating schedule with explicit true | Enable; no preview required |
| Automations gate off | Tool omitted and private endpoint refuses before validation |

**Tests.** Tool rows on every runner through the native mock wires, on fresh, Continue and
recovery paths, as `AGENT_PROTOCOL.md` requires for a Squawk tool. Unit tests for each refusal.

**Done when** an agent creates a paused automation and previews it through the tool on each
runner, and an enable without the explicit argument is refused.

## Slice 5: removal

**Goal:** delete what the switch stopped using, and record the decision.

- Delete: `skills-remote.ts`, `skills-provision.ts`, `server/skill-sources.ts`,
  `discoverSkills` and `SKILL_DIRS` in `skills.ts`, `skillSystemPrompt` and the `/name`
  expansion in `workflows/run/prompts.ts`, `automations/builtin-skill.ts`, the `skillsRepos`
  schema in `config.ts`, `disabledTeamSkills` in `packages/contract/src/workspace.ts`,
  `packages/contract/src/skill-sources.ts` and `team-skill-ref.ts`, their api-client mirrors,
  the `interactive` hint, `components/skill-empty-hint.tsx` and the two ast-grep rules
  `skills-read-outside-enabled-skills` (with its baseline file) and
  `skills-write-outside-load-run-skills`. The AST rule
  `cez/active-run-skills-write-outside-owner` stays: slice 3a changes what the `ActiveRun` skills
  group holds and updates its metadata in `packages/cezar/src/lint/active-run-write.ts`. Check the
  rules' current form first: hearsay-tools/squawk#3775 started porting ast-grep rules to oxlint.
- Move first, then delete: `agent-config/seed.ts` uses `excludeFromGit` and
  `worktree-manifest.ts` uses `landsInside`, both from `skills-remote.ts`. Move the two
  helpers to a module that stays.
- `project-commands.ts` (`hsq init`): stop writing the starter skill
  `project-conventions.md` into the project's `skills/` folder. Keep the starter workflow.
- Keep one small piece: the cleanup of what an older Squawk installed in task worktrees
  (`removeProvisionedSkills` and the `skills` writer of `worktree-manifest.ts`). It runs at the
  first step open or Continue after the upgrade, as the spec's worktree case table says.
- Saved data: a `config.json` with `skillsRepos` and a `ui-state.json` with
  `disabledTeamSkills` still load; the keys are ignored. Add one test for each file.
- Docs: rewrite `docs/areas/skills.md`; add an ADR that supersedes ADR 0023; update
  `README.md`, `docs/configuration.md`, `docs/migration.md` and `AGENT_PROTOCOL.md`; one line
  under Breaking in `CHANGELOG.md`; mark spec 005 as superseded by the runner-native spec and
  set that spec to `Status: done`.
- Close as superseded: hearsay-tools/squawk#1119, hearsay-tools/squawk#1539 and
  hearsay-tools/squawk#1439.

**Done when** `git grep` finds no reader of the deleted modules, a project with the old keys
in its saved files boots, and a worktree with old installed skills is cleaned at its next step.
