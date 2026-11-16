# Runner-native skills: implementation plan
Status: active

Plan for [the runner-native skills spec](2026-11-16-runner-native-skills.md). The spec holds the
design and the owner's decisions D1 and D3 to D8; this file says how the work is cut and what
each slice changes. Baseline: `main` at `6674cbeda`, after the Cursor removal
(hearsay-tools/squawk#3725). The probe reports are in
[`.ai/analysis/2026-11-16-runner-native-skills/`](../analysis/2026-11-16-runner-native-skills/).

Six slices, one pull request each. Delete this file when slice 5 merges.

## Order

| Slice | Starts after | Why |
| --- | --- | --- |
| 1. List seam | now | It adds code that nothing reads yet |
| 4. Automation tool | now | It touches the tool server, not the runner adapters |
| R. This repository's skills | now | It changes repository files only |
| 2. Trigger seam | slice 1 | Both edit the five adapter files and the mock wires |
| 3. Switch | slices 2 and R | It needs both seams, and it stops reading `.ai/skills/` |
| 5. Removal | slices 3 and 4 | It deletes what slice 3 stops using and the built-in skill that slice 4 replaces |

The five adapter files (`packages/cezar/src/core/{claude-cli,codex-app-server,opencode-server,pi,omp}-runner.ts`),
the mock wires in `packages/cezar/scripts/` and `core/runner-facts.ts` are hot files for slices
1 and 2. `workflows/run/` is a hot area for slices 3 and 5. Slices do not stack: each one lands
on `main` before the next one that shares a hot file starts.

## Rules for every slice

- A slice that adds a runner capability ships its parity rows in the same pull request, on the
  native mock wires through `HARNESS_ADAPTERS` ([runners](../../docs/areas/runners.md)). Extend
  the mock (`mock-claude.mjs`, `mock-codex-app-server.mjs`, `mock-opencode-serve.mjs`,
  `mock-pi-rpc.mjs`, `mock-omp-rpc.mjs`) to answer as the probe report for that runner records.
  Where a mock gains a new frame, record the real wire with `record-mock-wires.mjs` as the
  repository does for other frames.
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
  | Claude | `get_skills_dialog` control request to a short `claude` process with `--settings '{"disableAllHooks":true}'` and `--no-session-persistence` | No path in the answer. `--bare` and `--safe-mode` list nothing |
  | Codex | `skills/list` with `cwds`, after `initialize`, no thread | Reuse `codex-app-server-transport.ts` as `codex-model-catalog.ts` does. Map `errors` to `problems`. One id can come twice |
  | OpenCode | `GET /skill?directory=` | No scope field: derive it from `location`. The server caches its list. Drop entries under a `.trash` folder |
  | pi | RPC `get_commands` to `pi --mode rpc --no-session` | Launch with `pi-project-skills.mjs` exactly as `pi-runner.ts` does, or project skills are missing. Strip the `skill:` prefix from the id |
  | omp | `omp skill list --json` | Works without a login. Map `warnings` to `problems`. Map `source` (`provider:level`) to scope |

- The account home goes to the probe through `profileEnv` (`core/agent-profiles.ts`), the same
  way a session gets it.
- Facts in `core/runner-facts.ts`: `skillTriggerMidTurn` (true for pi only),
  `skillUnknownName` (`'error'` for OpenCode, `'silent'` for the rest) and
  `skillsSeenBySession` (`'live'` for Codex, `'at-start'` for the rest). Add them to
  `TURN_PATH_FACTS` in `core/parity-classes.testkit.ts`. Slice 3 adds the `FACT_VALUE_TESTS`
  entries when shared code first reads them.

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
change; mark the title with `!`.

Server and run path:

- `workflows/run/step-session.ts`: at step open, read the list for the step's runner, account
  and folder; resolve the reference (`{ id, path? }`, D8 for a duplicate id); fail the step
  before any model call when the id is missing or ambiguous; set `spec.skill`. Send no skill
  body in the system prompt.
- `workflows/run/launch-context.ts` (`sessionContextFor`): stop dropping the opening context
  for a slash opening. The adapter now places it.
- `workflows/run/continuation-session.ts` and `launch-read-resolver.ts`: a Continue that
  resumed sends no trigger; one whose `session` event says `resumed: false` sends the step's
  trigger again. `skipSkillOnResume` goes away with the skill prefix.
- `workflows/active-run.ts` and `run-skills.ts`: the session keeps the ids, paths and scopes
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
- `server/server.ts`: `GET /runner-skills?runner=&account=` replaces `GET /skills`,
  `GET /skills/importable` and `POST /skills/refresh`. A `refresh=1` query drops the cache
  entry first. Mirror it in `packages/api-client/src/contract/`.

Cockpit:

- `routes/skills.tsx`: a read-only inventory for one runner and account, with the runner's own
  problems and a re-read button. Remove `team-sources-panel.tsx`, the switches
  (`lib/use-skill-selection.ts`) and the shadow mark.
- Pickers read the list of the step's runner and account: `components/composer/`,
  `components/command-palette.tsx`, `routes/new-task*.ts(x)`,
  `routes/workflows/workflows-builder-sections.tsx`, `routes/github/hand-to-agent.tsx` and
  `routes/settings/prompt-templates-section.tsx`. A list that is
  unavailable still lets the user type an id.
- `components/skill-detail.tsx` shows what the runner reports. Squawk reads no skill file.

**Tests.** `FACT_VALUE_TESTS` entries for each skill fact value that the scenario runner does
not show. Shared parity rows for step open (known, missing and ambiguous id), a fresh-session
Continue, a held trigger and a typed name. Rewrite `packages/web/e2e/settings-skills.e2e.ts`
and `skill-search-ranking.e2e.ts` against a mock runner's list.

### State restore cases

The cockpit restores the last choice from `ui-state.json` (`lastTask`, `recentSources`). A
saved skill is a name; it carries no runner.

| Path or trigger | Restored value | Displayed value |
| --- | --- | --- |
| Reopen the new-task form with no saved choice | Nothing | The plain task, no skill |
| Reopen with a saved skill that the selected runner lists | The skill id | The skill, with the runner's description |
| Switch the runner in the form to one that does not list the saved skill | The saved id stays in `ui-state.json` | No skill selected, and a line that says the runner does not have it. Starting the task sends no skill |
| The saved skill is no longer in any list (a removed team skill) | The saved id stays until the user picks again | As the row above |
| The list is unavailable when the form opens | The skill id | The id as typed text, marked unchecked. Step open still checks it |

The picker derives the selection from the saved id and the current list. It never writes a
masked value back.

**Done when** a selected skill starts natively on each runner with no skill text in the system
prompt, a missing id fails before a model call, and no reader is left on `discoverSkills`.

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
  `skills-write-outside-load-run-skills`. The generated rule
  `active-run-skills-write-outside-owner` stays: slice 3 changes what the `ActiveRun` skills
  group holds, and regenerates the rule with `scripts/active-run-owner-rules.mjs`.
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
