# Runner-native skills
Status: active

Baseline: `main` at `00958e289`. Drafted with the owner on 2026-11-16 in task b99fbdec. The probe
reports are in [`.ai/analysis/2026-11-16-runner-native-skills/`](../analysis/2026-11-16-runner-native-skills/).
Two probe rounds ran on 2026-11-16; round 2 closed the open checks of the first draft.
This draft replaces the direction of the unmerged October drafts on branch `cez/4a7475dc`
(`2026-10-19-native-team-skills.md` and its two siblings); see [Earlier drafts](#earlier-drafts).

Scope: the five runners that remain after hearsay-tools/squawk#3715 removes Cursor: Claude,
Codex, OpenCode, pi and omp. This spec adds no Cursor code. The Cursor probe report stays in the
analysis folder as a record, in case the runner returns.

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

Facts that shape the design:

- **Every trigger works on a later turn and after a resume.**
- **Mid-turn messages differ.** pi expands a trigger in a steer. Codex `turn/steer` does not
  (real model). OpenCode steers a second command into the running turn.
- **Position rules differ.** Claude and pi need the trigger at the very start. Codex and omp
  accept it inside the text.
- **No project folder is read by all five.** `.agents/skills`: all but Claude. `.claude/skills`:
  all but Codex and pi.
- **Plugin names differ.** Claude and Codex use `plugin:skill`. OpenCode, pi and omp use bare
  names.
- **A list probe is not free of side effects on Claude.** The user's `SessionStart` hooks run
  on each one.
- **OpenCode's command route is a long poll.** Squawk left the long-poll message route for
  `prompt_async` because of `fetch failed` errors (`opencode-server-runner.ts`).
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
  `--settings '{"disableAllHooks":true}'`, `--no-session-persistence`,
  `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` (full list, no hook
  run, no session file); Codex `skills/list`; OpenCode `GET /skill`; pi RPC `get_commands`; omp
  `omp skill list --json` (the RPC list needs a selected model, the CLI list does not).
- **One id can have two entries.** Codex lists both copies of a name that two folders hold, and
  only the structured item with a `path` starts one of them; the text form starts neither. So a
  skill reference is `{ id, path? }`. A pick in the cockpit stores the `path` when the runner
  reports one. A reference with no path (a workflow's `skill:`, `worker spawn --skill`, a typed
  `/name`) that matches more than one entry is resolved by the scope the runner reports (D8):
  `repo` wins over `user`, and `user` wins over `system`. Squawk then sends the winner's `path`.
  When the best scope holds more than one copy, or a copy has another scope (Codex also reports
  `admin`), the reference is ambiguous. For a step's selected skill (a workflow's `skill:`,
  `worker spawn --skill`), the step fails at step open and the error names every path. A typed
  `/name` never fails a step; [the section on typed names](#a-name-typed-by-a-human) says what
  happens to it. Two cases stay
  failures under this rule, because Codex gives both copies one scope: `.agents/skills` and
  `.codex/skills` in one project are both `repo`, and `~/.agents/skills` and the Codex home's
  `skills` are both `user`. Codex deduplicates a symlinked mirror by resolved path; separate
  files with the same name remain separate entries (slice 1 check in [codex.md](../analysis/2026-11-16-runner-native-skills/codex.md)). Claude, OpenCode, pi and omp list one entry for each id.
- **`AgentRunSpec.skill = { id, path?, args }`** asks the adapter to open the turn with that skill. The
  adapter builds its own form, and each form below is tested:

  | Runner | Form | Rule the adapter must keep |
  | --- | --- | --- |
  | Claude | A last text block `/id args` | Opening context goes in an earlier text block of the same message. Context after the trigger block stops the expansion |
  | Codex | A `{type:"skill", name, path}` item with the listed `path`, plus the args as text, on `turn/start` | Never on `turn/steer`, and never on a `turn/start` sent during an active turn: both drop the skill |
  | OpenCode | `POST /session/{id}/command` | Read the response in the background. HTTP errors or `session.error` fail and end the turn; a dropped connection leaves SSE in charge. The request returns only at turn end and Node's `fetch` fails at 300 s. The user message that holds the skill body arrives on the event stream about 30 ms after the request; that is the sign of expansion. Never during a busy turn: a second command is steered into the running turn and the first skill's result is lost |
  | pi | `/skill:id args` at the start of the message | At least one argument must follow the id on the same line. `/skill:id` followed by a line break is not expanded. Opening context goes after the args |
  | omp | `/skill:id args` | The adapter maps the `custom` message with `customType: "skill-prompt"` to one user item on `message_start`. Repeated end frames add no item, and the frame releases the input hold |

- **Facts:** `skillTriggerMidTurn: boolean`, `skillUnknownName: 'error' | 'silent'` and
  `skillsSeenBySession: 'live' | 'at-start'` (Codex is `live`). All five runners list, so no
  fact is needed for a runner without a list.

### Starting a selected skill

A workflow step's `skill:`, a `skills:` stack, the composer pick and `worker spawn --skill` keep
their meaning: this step runs skill X.

1. At step open, Squawk lists the step's runner for the step's account and working folder.
2. If the id is not in the list, the step fails before any model call. The error names the
   runner, the account and the ids that are close. This check runs on every runner, because
   four of the five pass an unknown id to the model as plain text.
3. Squawk sends the trigger with the step's prompt as its arguments.
4. Squawk sends no skill body, installs no files and reads no skill file.

Continue is a plain resume when the runner resumes the stored session. It does not trigger the
skill again, because the body is already in the session and a second trigger would restart the
skill.

A Continue can also start a fresh session, for example when OpenCode no longer has the stored
session (`bootstrap` in `opencode-server-runner.ts`). A fresh session holds no skill body. The
adapter reports whether it resumed. When it did not, Squawk opens the fresh session with the
step's trigger, with the Continue message as its arguments, after the same check as at step
open. Shared code reads the adapter's report, never a runner id.

The opening context (handoff and `context.yaml` rules) keeps travelling with the opening message.
Its place differs per runner, as the table above says: an earlier text block on Claude, after
the arguments on pi. Each adapter pins its place with a parity row. Today that context is dropped
for a slash opening; this design sends it again.

### A `/name` typed by a human

Squawk no longer replaces a leading `/name` with a skill body. When the name is in the runner's
list, Squawk sends that runner's trigger (D3). During a running turn it holds such a message
until the turn ends when `skillTriggerMidTurn` is false: Claude, Codex and OpenCode (D6).
pi and omp expand a trigger inside the running turn. Claude queues it to a second turn.
See the slice 2 checks in [claude.md](../analysis/2026-11-16-runner-native-skills/claude.md)
and [omp.md](../analysis/2026-11-16-runner-native-skills/omp.md).

"The runner's list" here is the list as the running session sees it. Only Codex shows a skill
that was added after the session started. A pi process, an omp session and an OpenCode server
keep the list they started with, and Claude adds a skill only when its skills folder already
existed. On those four a fresh list would name a skill that the session does not know. On
Claude, pi and omp the trigger would then reach the model as plain text with no error; on
OpenCode the command request would fail with HTTP 500. So Squawk keeps the list it read
when the session's runner process started, and checks a later trigger against that list. On
Codex it reads the list again. A name that only a fresh list holds is not triggered: Squawk
passes the text and adds a note that the skill is available after the next Continue.

A typed `/name` can also be ambiguous: on Codex a second copy can appear after the step opened,
because Codex reads the list again. Squawk resolves the name when it sends the message. For a
held message that is when the turn ends and the message is released. It applies the D8 scope
rule first. When the name is still ambiguous, Squawk sends no trigger: it passes the text
unchanged and adds a note that names every path. The step does not fail and the message is
not rejected. To recover, the user picks the skill in the cockpit picker, which stores the
path, or removes one copy and sends the message again.

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

### What is removed

| Removed | Where |
| --- | --- |
| Team sources: bare clones, fetch TTL, statuses | `skills-remote.ts`, `server/skill-sources.ts`, `team-sources-panel.tsx`, `skillsRepos` in `config.ts`, `contract/skill-sources.ts` |
| Worktree install, companions, cache copies | `skills-provision.ts`, `provisionRunSkills` and the live-`/name` install in `run-skills.ts` |
| Per-skill off-list | `disabledTeamSkills` in `ui-state.json`, `use-skill-selection.ts`, `GET /skills/importable` |
| Inline body and `/name` expansion | `skillSystemPrompt`, `expandRegistrySlashSkillText` in `prompts.ts` |
| Squawk-only skill folders | `.ai/cezar/skills`, `.ai/squawk/skills`, `.ai/skills` as sources; `SKILL_DIRS` and the hint that copies it |
| The run's saved list of full skill records | `state.skills.catalog`, `loadRunSkills`, `enabledSkills` and their two ast-grep rules. The session keeps only the ids and paths it read at its start, to check later triggers |

`docs/areas/skills.md` is rewritten. A new ADR supersedes
[ADR 0023](../../docs/adr/0023-treat-skills-as-shared-content.md).

Saved data still opens: a `config.json` that holds `skillsRepos` and a `ui-state.json` that holds
`disabledTeamSkills` load with those keys ignored. Nothing else is kept for compatibility.

## Product decisions (owner, 2026-11-16)

| # | Question | Decision |
| --- | --- | --- |
| D1 | A second account of a runner has another home, so it can have other skills. ADR 0023 rejected this | Accepted. Skills follow the step's account home. Tested: Claude's list follows the home completely. Codex and pi lose their plugins and packages but keep `~/.agents/skills`. omp keeps `~/.agents/skills` and the Claude plugin cache. OpenCode has no account home in Squawk |
| D2 | Withdrawn. It asked how to list Cursor's skills; Cursor leaves Squawk (hearsay-tools/squawk#3715) | |
| D3 | A human types `/name` at the start of a message | When `name` is in the runner's list, Squawk sends that runner's trigger. Otherwise it passes the text unchanged, so the runner's own slash commands still work |
| D4 | A project skill folder that git ignores does not exist in a task worktree | Squawk does nothing. Step open fails with "not in this worktree" and names the folder. A project tracks its skills, or links them in `worktreeSetup` |
| D5 | Skills in `.ai/skills/` (this repository has five) are read by no runner | The folders stop being sources. This repository moves its skills to a tracked native folder in a separate change. `AGENTS.md` already names them by file path |
| D6 | pi and omp expand a trigger inside the running turn. Claude queues it to a second turn ([Claude check](../analysis/2026-11-16-runner-native-skills/claude.md#slice-2-trigger-checks-2026-11-16), [omp check](../analysis/2026-11-16-runner-native-skills/omp.md#slice-2-trigger-checks-2026-11-16)). Codex drops it. OpenCode steers it into the running turn and loses the first result | Squawk holds the message until the turn ends on runners whose `skillTriggerMidTurn` is false: Claude, Codex and OpenCode |
| D7 | The built-in "create automation" skill and the `interactive: true` frontmatter hint are Squawk's own | A tool in Squawk's own MCP server replaces the skill. Every adapter honors the Squawk tools, and `cezar_schedule_task` already wraps the same automation service for one-time schedules. The tool enforces "created paused" and "preview first". The picker entry and the `interactive` hint go away |
| D8 | One id with two entries in a runner's list (Codex), named without a path | Squawk picks by the scope the runner reports: `repo` over `user` over `system`. When two copies share the best scope, or a copy has another scope, a step's selected skill fails at step open with an error that names every path, and a typed `/name` is sent as plain text with a note that names every path |

## Checks closed in round 2

| Check | Result |
| --- | --- |
| Does each list follow a non-default account home? | Claude: yes, completely. Codex, pi: in part (`~/.agents/skills` stays). omp: only omp's own user skills. OpenCode: Squawk has no account home for it. Every list works without a login in that home, except omp's RPC list |
| Claude: context and trigger in one message | Works with the context block first and the trigger block last. The reverse order is not expanded |
| Claude: a list call that runs no user hooks | `--settings '{"disableAllHooks":true}'` gives the full list with no hook run. `--bare` and `--safe-mode` list no skills |
| Codex: `turn/steer` with a real model | Not expanded, for `$name` and for the structured item. `turn/interrupt` then `turn/start`, waiting for the turn end, and `thread/queue/add` do expand (mock provider) |
| OpenCode: the command route held open | Answers at turn end; events arrive meanwhile. `fetch` fails at 300 s. A dropped request does not stop the turn. No async form exists |
| pi: context after the trigger | Works when an argument follows the id. A user skill wins over a project skill of the same name under Squawk's launch |
| omp: Squawk's mapper on a skill turn | Turn start, turn end and session id are detected. The skill message produces no event |

## Checks closed in slices 1 and 2

- Claude: strict empty MCP configuration prevents user MCP startup and retains the full list.
  User and project hooks are disabled. See [Claude checks](../analysis/2026-11-16-runner-native-skills/claude.md).
- Codex: fresh-home native state writes are accepted; a symlinked mirror is deduplicated by
  resolved path. See [Codex checks](../analysis/2026-11-16-runner-native-skills/codex.md).
- omp: `OMP_PROFILE` works against the real root. Its mid-turn trigger expands inside the
  current turn. The skill appears once through mapper, persistence and rendered transcript.
  See [omp checks](../analysis/2026-11-16-runner-native-skills/omp.md).
- Claude: the mid-turn trigger runs in a second turn, so its fact stays false.
- All five runners return the fixture token without tools. Native mock parity and command
  failure checks are listed in [slice 2 evidence](../analysis/2026-11-16-runner-native-skills/slice2-evidence.md).

## Still open

- Claude: managed-policy hooks were not tested. User settings cannot disable them.

## Plan

Slices in order. Each is one pull request. [The plan](2026-11-16-runner-native-skills-plan.md)
says what each slice changes. It adds one slice, R, that makes this repository's own skills
reachable natively before slice 3 (D5).
Slice 1 starts after hearsay-tools/squawk#3715 merges, so that no slice writes Cursor code that
the removal then deletes.

1. **List seam.** `listSkills` on five adapters, the contract schema, the facts, and a parity
   family that runs on every runner. No product reader yet.
2. **Trigger seam.** `AgentRunSpec.skill` on five adapters with parity rows for the first turn,
   arguments, a later turn and a resume.
3. **Switch.** Step open, Continue, live input, worker `--skill`, the planner and auto-naming
   read the runner list and send the trigger. The cockpit pages and pickers move to the
   per-runner list. This slice is the breaking change (`!` in the title).
4. **Automation tool.** The MCP tool that replaces the built-in skill (D7). It can ship at any
   point before slice 5.
5. **Removal.** Delete the code in [What is removed](#what-is-removed), rewrite the area doc,
   add the ADR, and clean up as the case tables say.

## Case tables

### Worktree cases

Slice 5 removes files that an older Squawk installed in task worktrees. It calls
`removeProvisionedSkills` (`skills-provision.ts`), which removes only entries the worktree
manifest records and that are unchanged.

| Case | Files written, kept or removed | Worktree state at the next step, Continue and restart |
| --- | --- | --- |
| A catalog or source that has not loaded yet | None written: the new code installs nothing, so no load is awaited | Unchanged |
| The same name from two sources | None written. Squawk merges no sources and shows the runner's list. Codex can list one id twice; [the runner seam](#the-runner-seam) says how a reference picks one | Unchanged |
| Records written by an older Squawk version | At the first step open or Continue after the upgrade: every recorded, unchanged entry and Squawk's own `.gitignore` in the skills folders are removed, then the records. An entry the user or agent changed stays | The runner sees tracked skills and the user's own. A changed leftover stays until the worktree goes |
| A crash between two writes | Removal is repeatable: the records are dropped last, so the next step open removes what is left | Same as the row above after the next step open |
| The source removing the item | Not applicable: no source. A skill that leaves the runner's list is absent at the next list read; a step that names it fails at step open | Unchanged |

### Process exits

`listSkills` starts a short runner process on Claude, Codex, pi and omp, and uses the running
server on OpenCode. None of them is started detached, so the detached-spawn table does not
apply. Each probe has a timeout and stops its child by the process it started.

## Earlier drafts

The October drafts kept a Squawk-owned store: Squawk fetched team repositories, pinned each
session to one commit, and loaded them through a session-only route of each runner. This draft
drops the store, the pin and the per-source trust flag. A team shares skills through the
runner's own project configuration in git, or through tracked skill folders. The research on
session-only routes stays valid and is not used here.
