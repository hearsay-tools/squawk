# Runner-native skills
Status: draft

Baseline: `main` at `00958e289`. Drafted with the owner on 2026-11-16 in task b99fbdec. The probe
reports are in [`.ai/analysis/2026-11-16-runner-native-skills/`](../analysis/2026-11-16-runner-native-skills/).
Two probe rounds ran on 2026-11-16; round 2 closed the open checks of the first draft.
This draft replaces the direction of the unmerged October drafts on branch `cez/4a7475dc`
(`2026-10-19-native-team-skills.md` and its two siblings); see [Earlier drafts](#earlier-drafts).

## Goal

Squawk stops keeping its own skill catalog. A skill is whatever the step's runner already has:
the user's own setup, the project's tracked skill folders and the runner's plugins. Squawk does
two things only:

1. It asks the runner which skills it has, and shows that list in the cockpit.
2. It starts a named skill through the runner's own trigger.

Squawk no longer clones skill repositories, copies skills into worktrees, guesses companion
skills, or puts a skill body into the system prompt.

## Evidence

### What Squawk does today

- `discoverSkills` (`skills.ts`) merges project folders, `~/.agents/skills`, `~/.claude/skills`,
  team repositories (`skillsRepos`, bare clones in `<cache>/skills`) and one built-in into one
  list keyed by bare name. The first name wins.
- A selected skill reaches the agent on three paths at once: its body in the system prompt
  (`skillSystemPrompt`), a leading `/name` replaced by the body (`expandRegistrySlashSkillText`),
  and files installed in the worktree's `.claude/skills`, `.agents/skills` and `.cursor/skills`
  (`provisionRunSkills`, `skills-provision.ts`), with up to 24 companions found by a name match
  in the body (`mentionsSkill`).
- The system prompt body is the original definition of a Squawk skill
  ([spec 005](005-remote-skills.md), item 5). The copies exist because a task worktree holds
  tracked files only, and a team skill exists only inside a bare clone.
- The runner's own skills are a second list. Squawk passes no `--setting-sources` flag by
  default, so a Claude task already loads the user's plugins and global skills. Squawk neither
  shows nor controls them.
- On the owner's host: 4 team sources give 98 skill files, and 35 of them are switched off.

### What the runners can do (probe, 2026-11-16)

Each runner was driven through the transport Squawk uses for it. "Runner expands" means the
runner put the skill body into the turn itself, with no tool call by the model.

| Runner | List without a model call | Trigger the runner expands | Unknown name |
| --- | --- | --- | --- |
| Claude 2.1.321 | `get_skills_dialog` control request, 0.5 s; name, description, source, no path | `/name args`, `/` as the first character of the last text block | silent |
| Codex 0.164.0 | `skills/list`, no thread, under 0.5 s; name, description, path, scope, plugin id, errors | `$name` in the text, or a `{type:"skill", name, path}` item, on `turn/start` | silent |
| OpenCode 1.19.4 | `GET /skill`, 0.1 s; name, description, location, content | `POST /session/{id}/command` | HTTP 500 |
| pi 1.4.0 | RPC `get_commands`, 0.5 to 1.1 s; name, description, path, scope | `/skill:name args` at the start of the message | silent |
| omp 18.13.1 | `omp skill list --json`, 0.2 s; name, description, path, source, warnings | `/skill:name args` | silent |
| Cursor 2026.11.13 | none in print mode | `/folder-name` anywhere in the prompt text | silent |

Facts that shape the design:

- **Every trigger works on a later turn and after a resume.**
- **Mid-turn messages differ.** pi expands a trigger in a steer. Codex `turn/steer` does not
  (real model). OpenCode steers a second command into the running turn.
- **Position rules differ.** Claude and pi need the trigger at the very start. Codex, omp and
  Cursor accept it inside the text. Cursor also matches a `/name` inside the system prompt text
  that Squawk prepends to the prompt.
- **No project folder is read by all six.** `.agents/skills`: all but Claude. `.claude/skills`:
  all but Codex and pi.
- **Plugin names differ.** Claude and Codex use `plugin:skill`. OpenCode, pi, omp and Cursor use
  bare names.
- **A list probe is not free of side effects on Claude.** The user's `SessionStart` hooks run
  on each one.
- **OpenCode's command route is a long poll.** Squawk left the long-poll message route for
  `prompt_async` because of `fetch failed` errors (`opencode-server-runner.ts`).
- **Cursor ACP can list** (`available_commands_update` after `session/new`, 5.5 to 6.1 s, name
  and description only), but Squawk removed its ACP transport (hearsay-tools/cezarion#1267). On
  the owner's host the ACP list held 20 of the 75 names that print mode could start: it leaves
  out all 52 plugin skills, and adds 12 entries that are not skills. Each call writes one small
  session record that stays.
- **Today's opening prefix already conflicts with triggers.** `sessionContextFor`
  (`launch-context.ts`) drops the handoff and context prefix when the opening message is a slash
  command, because the command must stay at character zero (hearsay-tools/cezarion#676).

## Proposed design

### The runner seam

Each runner adapter gains two capabilities, and `RUNNER_FACTS` gains the facts that shared code
needs to choose between them.

- **`listSkills({ cwd, account })`** returns `{ skills, problems }`. One skill is
  `{ id, name, description?, scope?, plugin?, path? }`. `id` is the exact value the trigger
  takes. `problems` carries what the runner reports as broken or dropped (Codex `errors`, omp
  `warnings`). Fields a runner does not report stay absent; Squawk does not fill them from the
  file system. Tested routes: Claude `get_skills_dialog` with
  `--settings '{"disableAllHooks":true}'` and `--no-session-persistence` (full list, no hook
  run, no session file); Codex `skills/list`; OpenCode `GET /skill`; pi RPC `get_commands`; omp
  `omp skill list --json` (the RPC list needs a selected model, the CLI list does not).
- **`AgentRunSpec.skill = { id, args }`** asks the adapter to open the turn with that skill. The
  adapter builds its own form, and each form below is tested:

  | Runner | Form | Rule the adapter must keep |
  | --- | --- | --- |
  | Claude | A last text block `/id args` | Opening context goes in an earlier text block of the same message. Context after the trigger block stops the expansion |
  | Codex | A `{type:"skill", name, path}` item with the listed `path`, plus the args as text, on `turn/start` | Never on `turn/steer`, and never on a `turn/start` sent during an active turn: both drop the skill |
  | OpenCode | `POST /session/{id}/command` | Do not wait for the answer. The request returns only at turn end and Node's `fetch` fails at 300 s. The user message that holds the skill body arrives on the event stream about 30 ms after the request; that is the sign of expansion. Never during a busy turn: a second command is steered into the running turn and the first skill's result is lost |
  | pi | `/skill:id args` at the start of the message | At least one argument must follow the id on the same line. `/skill:id` followed by a line break is not expanded. Opening context goes after the args |
  | omp | `/skill:id args` | The adapter maps the `custom` message with `customType: "skill-prompt"` to a user-message event. Today it produces no event, so the transcript has no trace of the skill |
  | Cursor | `/id` followed by the args | The id is the folder name. See [Cursor matches Squawk's own text](#cursor-matches-squawks-own-text) |

- **Facts:** `skillList: 'full' | 'none'`, `skillTriggerMidTurn: boolean`, and
  `skillUnknownName: 'error' | 'silent'`.

### Starting a selected skill

A workflow step's `skill:`, a `skills:` stack, the composer pick and `worker spawn --skill` keep
their meaning: this step runs skill X.

1. At step open, Squawk lists the step's runner for the step's account and working folder.
2. If the id is not in the list, the step fails before any model call. The error names the
   runner, the account and the ids that are close. On a runner with `skillList: 'none'`, this
   check does not run.
3. Squawk sends the trigger with the step's prompt as its arguments.
4. Squawk sends no skill body, installs no files and reads no skill file.

Continue is a plain resume. It does not trigger the skill again, because the body is already in
the session and a second trigger would restart the skill.

The opening context (handoff and `context.yaml` rules) keeps travelling with the opening message.
Its place differs per runner, as the table above says: an earlier text block on Claude, after
the arguments on pi. Each adapter pins its place with a parity row. Today that context is dropped
for a slash opening; this design sends it again.

### A `/name` typed by a human

Squawk no longer replaces a leading `/name` with a skill body. See decision D3 for what it does
with it.

### The cockpit

- **Skills page:** a read-only inventory for one runner and account: name, description, scope
  or source, path when the runner reports one, and the runner's own problems. It has a re-read
  button. The team sources panel, the per-skill switches and the "shadowed by a local skill"
  mark go away.
- **Pickers** (composer, ⌘K, workflow editor, planner): they list the skills of the runner and
  account selected for the step. A step with another runner gets another list.
- **Reads never block.** The server caches each list per runner, account home and folder for a
  short time, joins concurrent reads, and bounds each probe with a timeout. A failed or slow
  probe shows "list unavailable" and the composer still accepts a typed id.
- **Changing what a runner has** (install a plugin, add a skill) is not in this spec. A later
  spec adds it, and it calls the runner's own CLI; Squawk does not edit runner files.

### Cursor matches Squawk's own text

Cursor print mode scans the whole stdin text with `(?:^|\s)\/([a-zA-Z0-9_-]+)` and attaches the
skill whose folder has that name. A path after a space matches by its first segment. Squawk
prepends its system prompt and the handoff to that text. A sample of Squawk's own text matched
four ids: the selected skill's name, `tmp`, `home` and `cezar` (from an unquoted worktree path and
the `<!-- /cezar:records -->` marker). A turn with skill folders of those names attached all four.

This happens today, apart from this design. A character that is not whitespace before the `/`
(a quote or a backtick) stops the match. The Cursor adapter must therefore send no ` /word` of
its own: it quotes every path and marker in the text it adds. A parity row pins that the text
Squawk adds holds no match.

### What is removed

| Removed | Where |
| --- | --- |
| Team sources: bare clones, fetch TTL, statuses | `skills-remote.ts`, `server/skill-sources.ts`, `team-sources-panel.tsx`, `skillsRepos` in `config.ts`, `contract/skill-sources.ts` |
| Worktree install, companions, cache copies | `skills-provision.ts`, `provisionRunSkills` and the live-`/name` install in `run-skills.ts` |
| Per-skill off-list | `disabledTeamSkills` in `ui-state.json`, `use-skill-selection.ts`, `GET /skills/importable` |
| Inline body and `/name` expansion | `skillSystemPrompt`, `expandRegistrySlashSkillText` in `prompts.ts` |
| Squawk-only skill folders | `.ai/cezar/skills`, `.ai/squawk/skills`, `.ai/skills` as sources; `SKILL_DIRS` and the hint that copies it |
| The run's saved list | `state.skills.catalog`, `loadRunSkills`, `enabledSkills` and their two ast-grep rules |

`docs/areas/skills.md` is rewritten. A new ADR supersedes
[ADR 0023](../../docs/adr/0023-treat-skills-as-shared-content.md).

Saved data still opens: a `config.json` that holds `skillsRepos` and a `ui-state.json` that holds
`disabledTeamSkills` load with those keys ignored. Nothing else is kept for compatibility.

## Decisions for the owner

| # | Question | Options | Proposed |
| --- | --- | --- | --- |
| D1 | A second account of a runner has another home, so it can have other skills. ADR 0023 rejected this. Tested: Claude's list follows the home completely. Codex and pi lose their plugins and packages but keep `~/.agents/skills`. omp keeps `~/.agents/skills` and the Claude plugin cache. OpenCode and Cursor have no account home in Squawk | (a) accept; (b) keep one shared library, which needs Squawk to inject it | (a). It is what "use the runner's setup" means. A skill in `~/.agents/skills` reaches every account of every runner but Claude |
| D2 | Cursor has no list in print mode. | (a) no list: the picker takes a typed id and step open does not check it; (b) ACP list, marked partial, typed ids still accepted; (c) Squawk reads Cursor's folders and plugin cache itself | (a) first. (b) shows about a quarter of the skills on a host with plugins and costs 5 to 6 s. (c) is the layer this spec removes |
| D3 | A human types `/name` at the start of a message. | (a) pass the text unchanged: it works on Claude and Cursor only; (b) when `name` is in the runner's list, send that runner's trigger; otherwise pass the text unchanged | (b). One way to type a skill on every runner, and the runner's own slash commands still pass through |
| D4 | A project skill folder that git ignores does not exist in a task worktree. | (a) Squawk does nothing; step open fails with "not in this worktree" and names the folder; (b) Squawk links ignored skill folders from the main checkout into each new worktree | (a). A project tracks its skills, or links them in `worktreeSetup` |
| D5 | Skills in `.ai/skills/` (this repository has five) are read by no runner. | (a) drop the folders as sources; this repository moves its skills to a tracked native folder in a separate change; (b) keep `.ai/skills` as a Squawk-only source with the inline body | (a). `AGENTS.md` already names these skills by file path, which needs no skill mechanism |
| D6 | A trigger in a message sent during a running turn. Tested: pi expands it. Codex drops it. OpenCode steers it into the running turn and loses the first result. Claude, omp and Cursor: not tested | (a) send as text and show a note; (b) hold the message until the turn ends, then open the next turn with the trigger | (b) on every runner but pi. Codex and OpenCode both expand a trigger that opens the next turn, and (a) sends text the model may not act on |
| D7 | The built-in "create automation" skill and the `interactive: true` frontmatter hint are Squawk's own. | (a) drop both: the automations part of the system prompt stays; (b) keep them as Squawk prompt presets, outside the skill list; (c) replace the skill with a tool in Squawk's own MCP server, as the owner asked on 2026-11-16 | (c). All six adapters honor the Squawk tools. `cezar_schedule_task` already wraps the same automation service for one-time schedules. The tool can enforce "created paused" and "preview first", which a playbook only asks for. The picker entry and the `interactive` hint go away |

## Checks closed in round 2

| Check | Result |
| --- | --- |
| Does each list follow a non-default account home? | Claude: yes, completely. Codex, pi: in part (`~/.agents/skills` stays). omp: only omp's own user skills. OpenCode, Cursor: Squawk has no account home for them. Every list works without a login in that home, except omp's RPC list |
| Claude: context and trigger in one message | Works with the context block first and the trigger block last. The reverse order is not expanded |
| Claude: a list call that runs no user hooks | `--settings '{"disableAllHooks":true}'` gives the full list with no hook run. `--bare` and `--safe-mode` list no skills |
| Codex: `turn/steer` with a real model | Not expanded, for `$name` and for the structured item. `turn/interrupt` then `turn/start`, waiting for the turn end, and `thread/queue/add` do expand (mock provider) |
| OpenCode: the command route held open | Answers at turn end; events arrive meanwhile. `fetch` fails at 300 s. A dropped request does not stop the turn. No async form exists |
| pi: context after the trigger | Works when an argument follows the id. A user skill wins over a project skill of the same name under Squawk's launch |
| omp: Squawk's mapper on a skill turn | Turn start, turn end and session id are detected. The skill message produces no event |
| Cursor: Squawk's own text | Four accidental matches in a sample of Squawk's text; all four skills attached |

## Still open

- Claude: whether the user's MCP servers start during a list call; hooks from managed policy.
- Claude, omp, Cursor: a trigger in a message during a running turn.
- Codex: a list call with a fresh home writes state files into that home.
- omp: `OMP_PROFILE` against the real omp root (the probe used a scratch root).
- The layers above the omp adapter on a skill turn.

## Plan

Slices in order. Each is one pull request. A `-plan.md` follows when the decisions are taken.

1. **List seam.** `listSkills` on six adapters, the contract schema, the facts, and a parity
   family that runs on every runner. No product reader yet.
2. **Trigger seam.** `AgentRunSpec.skill` on six adapters with parity rows for the first turn,
   arguments, a later turn and a resume.
3. **Switch.** Step open, Continue, live input, worker `--skill`, the planner and auto-naming
   read the runner list and send the trigger. The cockpit pages and pickers move to the
   per-runner list. This slice is the breaking change (`!` in the title).
4. **Removal.** Delete the code in [What is removed](#what-is-removed), rewrite the area doc,
   add the ADR, and clean up as the case tables say.

## Case tables

### Worktree cases

Slice 4 removes files that an older Squawk installed in task worktrees. It calls
`removeProvisionedSkills` (`skills-provision.ts`), which removes only entries the worktree
manifest records and that are unchanged.

| Case | Files written, kept or removed | Worktree state at the next step, Continue and restart |
| --- | --- | --- |
| A catalog or source that has not loaded yet | None written: the new code installs nothing, so no load is awaited | Unchanged |
| The same name from two sources | Not possible in Squawk: it merges no sources. The runner resolves its own duplicates and Squawk shows the runner's list | Unchanged |
| Records written by an older Squawk version | At the first step open or Continue after the upgrade: every recorded, unchanged entry and Squawk's own `.gitignore` in the skills folders are removed, then the records. An entry the user or agent changed stays | The runner sees tracked skills and the user's own. A changed leftover stays until the worktree goes |
| A crash between two writes | Removal is repeatable: the records are dropped last, so the next step open removes what is left | Same as the row above after the next step open |
| The source removing the item | Not applicable: no source. A skill that leaves the runner's list is absent at the next list read; a step that names it fails at step open | Unchanged |

### Process exits

`listSkills` starts a short runner process on Claude, Codex, pi and omp, and uses the running
server on OpenCode. None of them is started detached, so the detached-spawn table does not
apply. Each probe has a timeout and stops its child by the process it started.

Decision D2 option (b) would add a Cursor ACP process. Its helper processes stay for about
300 s unless the process group is signalled. That option needs the process-exits table before
implementation.

## Earlier drafts

The October drafts kept a Squawk-owned store: Squawk fetched team repositories, pinned each
session to one commit, and loaded them through a session-only route of each runner. This draft
drops the store, the pin and the per-source trust flag. A team shares skills through the
runner's own project configuration in git, or through tracked skill folders. The research on
session-only routes stays valid and is not used here.
