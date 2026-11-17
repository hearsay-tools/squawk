# omp: native skill listing and native skill trigger

Probe date 2026-11-16. Runner: **omp (oh-my-pi) 18.13.1**, binary `~/.local/bin/omp` (a compiled
Bun executable; "source" below means the JavaScript read out of that binary with `strings`, file names from
its `// packages/...` comments). Default account, no `OMP_PROFILE`. The user config has no `skills.*` and no
`disabledExtensions` key, so omp's defaults applied.

Model: `<provider>/gpt-5.6-luna` (`--model`), the smallest tier the default account offers. The
account's own default model was `<provider>/gpt-6.1-sol`. 12 model turns used, 0 timeouts. The model followed
"reply with exactly this token" in every turn, so the answers and the event stream agree.

Marks: **TESTED** (ran it), **DOCS** (read in the 18.13.1 source or `--help`), **NOT TESTED**.

## Step 0: how Squawk drives omp

From `packages/cezar/src/core/omp-runner.ts`:

- Transport: one child per session, `omp --mode rpc`, JSON lines on stdin and stdout (`buildOmpArgs`).
- Argv: `--mode rpc`, then as set: `--extension <omp-ci-wait.mjs>`, `--resume <sessionId>`,
  `--append-system-prompt <text>`, `--model <provider/model>`, `--thinking <level>`, `--add-dir <dir>`,
  and `--tools <list>` or `--no-tools`. An unset tool grant passes no tool flag. No `--config`, no
  `--no-skills`, no `--skills`, no approval flag.
- Startup commands, written after omp's `ready` frame: `get_state`, `set_steering_mode {mode:"all"}`,
  `set_subagent_subscription {level:"events"}`, `set_event_filter {events:null, messageUpdates:"delta"}`.
- First prompt and every later message: `{"type":"prompt","id":…,"message":…}`; a message sent while a turn
  runs adds `"streamingBehavior":"steer"`. A turn ends at `session_settled`.
- Resume (Continue): a new process with `--resume <sessionId>`.
- Account: a named account sets `OMP_PROFILE=<profile name>` (`agent-profiles.ts`); the default account
  spawns bare. `buildChildEnv` passes `OMP_*` and `PI_*` through.

All RPC probes below used that transport and those four startup commands, with `--model` and no tool flag
unless stated. My driver also set `TMPDIR=/tmp` and removed `CEZ_*`, `HSQ_*`, `CLAUDE*`, `ANTHROPIC_*` from
the child env.

## Results

| # | Verdict | Evidence |
|---|---|---|
| L1 | **Yes, two ways, no model call.** | See "L1" below. |
| L2 | **cwd-sensitive.** Home variable: DOCS only. | See "L2" below. |
| T1 | **`/skill:<name>` is expanded by the runner.** Plain `/<name>` is not. | See "T1" below. |
| T2 | **Arguments reach the skill.** | `/skill:probe-alpha hello world` → `details.args:"hello world"`, body ends `User: hello world`, answer `ALPHA-0213da43: hello world`. TESTED. |
| T3 | **Runner expansion, also mid-text.** | `Say hi, then run /skill:probe-gamma` → `skill-prompt` for `probe-gamma` with `details.args:"Say hi, then run"`; answer `GAMMA-689b93cf: Say hi, then run`. TESTED. |
| T4 | **Silent: plain text to the model.** | `/skill:probe-nope` and `/probe-nope` both arrive as a `user` message; `response` is `success:true`, `prompt_result` is `completed`. No error or notice frame. TESTED. |
| T5 | **Model choice, `read` tool.** | `Use the probe-gamma skill.` → `tool_execution_start` `read {"path":"skill://probe-gamma"}`, then `GAMMA-689b93cf`. TESTED. |
| T6 | **Readable with Squawk's default launch, no prompt.** | See "T6" below. |
| T7 | **Works in a later turn and after `--resume`.** | Turn 2 of the session: T2 above. New process `--resume <id>` (`messageCount` 12): `/skill:probe-gamma resumed` → `skill-prompt`, answer `GAMMA-689b93cf: resumed`. TESTED. |
| T8 | **A running session does not see a new skill; a resume does.** | See "T8" below. |

### L1: list without a model call

**a) CLI, no session:** `omp skill list --json`, run in the working directory. TESTED, 0.21 s wall.

```
{"skills":[{"name":"probe-alpha","description":"Probe fixture skill probe-alpha for a runner behaviour test.",
  "filePath":"/tmp/skill-probe-omp.uOEuF6/.omp/skills/probe-alpha/SKILL.md",
  "baseDir":"/tmp/skill-probe-omp.uOEuF6/.omp/skills/probe-alpha","source":"native:project","hide":false}, …],
 "warnings":[{"skillPath":"","message":"… Skipping skill \"<skill>\": unexpected frontmatter field \"requires\""}, …]}
```

- Keys per skill: `name`, `description`, `filePath`, `baseDir`, `source`, `hide`. `source` is
  `<provider>:<level>`, so it carries the scope.
- Sources seen here: `native:project`, `claude:project`, `agents:project`, `codex:project`,
  `opencode:project`, `github:project` (project); `agents:user` (`~/.agents/skills`); `agent-plugins:user` and
  `claude-plugins:project` (both under `~/.claude/plugins/cache/...`). So it lists project, user-level and
  plugin skills.
- `warnings` holds dropped skills and name collisions. Nothing else reports them.
- `omp skill --help` describes the command as the Skillshare registry tool and does not say that `list`
  covers every discovered skill. `omp skill list` without `--json` prints `name<TAB>description`.
- It has no `--config` flag in `--help`; whether it honours an overlay is NOT TESTED.

**b) RPC, inside the session Squawk already runs:** `{"type":"get_available_commands","id":"cmds"}`. TESTED.
Process start to `ready` about 0.7–1.1 s; the response then takes 3–7 ms (445 ms on the first cold run).

```
{"id":"cmds","type":"response","command":"get_available_commands","success":true,"data":{"commands":[
  {"name":"skill:probe-alpha","description":"Probe fixture skill probe-alpha for a runner behaviour test.",
   "input":{"hint":"arguments"},"source":"skill"}, …]}}
```

- Skills are the entries with `source:"skill"`; the name has the `skill:` prefix. No path, no scope.
- The same list arrives unasked as an `available_commands_update` frame right after `ready`.
- The name set equals `omp skill list --json` (47 names in both, `diff` empty). TESTED.
- Works with zero prompts sent, so no model call. It needs `skills.enableSkillCommands` (default `true`,
  DOCS: settings schema); with it off the skill entries are absent (DOCS:
  `slash-commands/available-commands.ts`).

Also TESTED, no session: `omp read skill://probe-alpha` prints the SKILL.md (0.22 s);
`omp read skill://probe-alpha/references/extra.md` prints the reference file; `omp read skill://probe-nope`
prints `Unknown skill: probe-nope` and `Available: <all names>`.

Folders read at project level, by marker skills (TESTED):

| Folder | Read from cwd | Read from an ancestor of cwd (`sub/dir`) |
|---|---|---|
| `.omp/skills` | yes | yes |
| `.claude/skills` | yes | yes |
| `.agents/skills` | yes | yes |
| `.codex/skills` | yes | no |
| `.opencode/skills` | yes | no |
| `.github/skills` | yes | no |
| `.cursor/skills`, `.pi/skills`, `.gemini/skills` | no | no |

Only `<folder>/<dir>/SKILL.md` one level deep is read: a skill two levels deep and a flat `name.md` were not
listed. TESTED.

Flags that change the list (TESTED through RPC): `--no-skills` → 0 skills; `--skills 'probe-*'` → only the
3 matching names; `--config <overlay.yml>` with `skills.customDirectories: [<dir>]` adds that folder's
skills, and `disabledExtensions: [skill:probe-dup]` in the same overlay removed all three copies of that
name.

### L2: sensitivity

- cwd, TESTED: scratch root → 47 skills; `sub/dir` inside it → 44 (the three cwd-only folders drop out); an
  empty directory outside the repo → 27 (user and plugin skills only). `--cwd <scratch>` from the empty
  directory gives the scratch root's 47.
- Home variable: Squawk sets `OMP_PROFILE` for a named account. NOT TESTED (brief: cwd only). DOCS: `--help`
  says a profile isolates "auth, sessions, settings, and caches"; user-level skills of the `native` provider
  come from the agent directory (`<agent dir>/skills`, `discovery/builtin.ts`), which is per profile.
  `~/.agents/skills` and `~/.claude/plugins` are not under the omp home.

### T1: explicit trigger

| Input (whole RPC `prompt.message`) | Token | Who loaded the body |
|---|---|---|
| `/skill:probe-alpha` | `ALPHA-0213da43` | **Runner.** No tool call. TESTED. |
| `/skill:probe-alpha hello world` | `ALPHA-0213da43: hello world` | **Runner.** TESTED. |
| `/probe-alpha` | `ALPHA-0213da43` | **Model.** Arrives as a plain `user` message; the model called `read {"path":"skill://probe-alpha"}`. TESTED. |
| `$probe-alpha` | — | NOT TESTED. DOCS: the parser (`extensibility/skills.ts`) knows only `/skill:`. |
| structured skill item, dedicated request | — | None exists in the RPC command list (DOCS: `modes/rpc/rpc-mode.ts`). |

Stream of the runner expansion (TESTED, `--mode rpc`):

```
→ {"type":"prompt","id":"t1","message":"/skill:probe-alpha"}
← {"type":"response","id":"t1","command":"prompt","success":true}
← {"type":"message_start","message":{"role":"custom","customType":"skill-prompt","attribution":"user",
    "details":{"name":"probe-alpha","path":"/tmp/…/.omp/skills/probe-alpha/SKILL.md","prompt":"/skill:probe-alpha","lineCount":5},
    "content":"[IMPORTANT: User invoked the \"probe-alpha\" skill; follow its instructions. Full skill below.]\n\n# probe-alpha\n\nReply with exactly this token … \n\n---\n\n[Skill directory: /tmp/…/.omp/skills/probe-alpha]\nResolve relative paths in this skill … against this absolute directory; …"}}
← {"type":"message_end","message":{"role":"assistant", … "ALPHA-0213da43"}}
← {"type":"prompt_result","id":"t1","status":"completed","agentInvoked":true}
← {"type":"session_settled"}
```

The expanded turn has no `user` message: the prompt arrives as role `custom`, with the typed text in
`details.prompt`. The frontmatter is stripped from the injected body.

**Print mode differs.** `omp -p --mode json --model … "/skill:probe-gamma printmode"` sent the text as a
plain `user` message; the model then called `read skill://probe-gamma` and answered
`GAMMA-689b93cf: printmode`. No runner expansion in `-p`. TESTED (one turn).

DOCS: the RPC prompt handler tries the skill command first, then built-in slash commands, then the normal
prompt (`modes/rpc/rpc-mode.ts`); it passes the prompt's `streamingBehavior`, so a steer is parsed the same
way. A steer during a running turn is NOT TESTED. The ACP agent has the same expansion
(`modes/acp/acp-agent.ts`).

### T6: reference file

In the session of T1/T2, `What is the extra token?` → `tool_execution_start`
`read {"path":"/tmp/…/.omp/skills/probe-alpha/references/extra.md"}` → `BETA-a03aa897`. TESTED with Squawk's
default launch: no `--tools`, no approval flag. No approval request appeared (the only
`extension_ui_request` frames were `setWidget autoresearch`). The model used the absolute path built from the
`[Skill directory: …]` line the runner adds.

With `--no-tools` (TESTED on a resume): the trigger still injects the body (`/skill:probe-late after-resume`
→ `LATE-21aea323: after-resume`), `get_available_commands` still lists the skills, the built-in tools are
gone (10 `mcp__*` tools remained), and the system prompt has no `<skills>` section. A reference read without
the `read` tool is NOT TESTED; a narrowed `--tools` list without `read` is NOT TESTED.

### T8: skill added after the session started

In the resumed process, after T7, I created `.claude/skills/probe-late/SKILL.md` and waited 3 s. TESTED:

- `get_available_commands` before and after: 47 skills, no `skill:probe-late`. No new
  `available_commands_update` frame.
- `/skill:probe-late` → plain `user` message; the model answered `Skill not found: \`probe-late\`.` (its
  own words, no tool call).
- Next process with `--resume <id>`: 48 skills, `skill:probe-late` listed, trigger expanded by the runner.

## Name rules, duplicates, plugin names

- Name = frontmatter `name`, trimmed; without it, the folder name (`rule-noname`, `rule-nofm`). It need not
  match the folder: folder `folder-x` with `name: named-y` is listed as `named-y`. TESTED.
- No charset rule: `Rule Upper_Case` and `plug:rule-colon` are listed. Only a `/` or `\` in the name drops
  the skill (DOCS: `discovery/helpers.ts`). TESTED for the two listed names.
- A name with a space cannot be triggered: the parser ends the name at the first whitespace (DOCS).
- Dropped from the list: `enabled: false` (TESTED); no `description` in `.omp/skills` (TESTED), while
  `.claude/skills` lists a skill with no description (TESTED).
- `hide: true` and `disable-model-invocation: true`: still listed (`hide:true` in the CLI JSON) and still in
  `get_available_commands`, but left out of the system prompt's `<skills>` list. TESTED.
- `requires` in a project `.claude/skills` SKILL.md: listed. TESTED. `requires` in a Claude plugin's skill:
  dropped, with the warning `Skipping skill "<name>": unexpected frontmatter field "requires"`; 11 of the 17
  warnings here are this, the other 6 are name collisions. TESTED on the installed plugins.
- Same name, identical body and frontmatter in several folders: one entry, the `.omp/skills` copy
  (`probe-alpha` in six folders → one, `native:project`). TESTED.
- Same name, different content: `.omp/skills` keeps the bare name `probe-dup`; the others become
  `claude/probe-dup` and `agents/probe-dup` (`<namespace>/<name>`, then `~2`, `~3`). The warning
  `name collision: … available as "claude/probe-dup"` appears only in `omp skill list --json`. TESTED for the
  list. Trigger of a namespaced name: DOCS only (the parser accepts one `/` in the name).
- Plugin skills use bare names (`code-review`, `plan-issue`), not `plugin:skill`. Four cached versions of one
  plugin gave `<name>`, `<plugin>/<name>`, `<plugin>/<name>~2`, `<plugin>/<name>~3`. TESTED for the list.

## Surprises

- `-p` does not expand `/skill:<name>`; `--mode rpc` does. A check in print mode gives the wrong answer for
  Squawk's transport.
- `omp skill list --json` is a full local inventory with paths and sources, although `--help` presents
  `omp skill` as a registry client.
- Mid-text `/skill:<name>` is expanded, and the rest of the message becomes the skill's arguments. Any
  message that contains `/skill:<known name>` as its own word triggers that skill, unless the message starts
  with `/` (other than `/skill:`), `!` or `$ ` (the start-of-message exceptions are DOCS:
  `packages/tui/src/prompt/skill-tokens.ts`).
- An unknown skill name gives no error anywhere: the text goes to the model.
- The expanded prompt is a `custom` message (`customType:"skill-prompt"`), not a `user` message.
  `omp-runner.ts` and `omp-ui-mapper.ts` do not mention `skill-prompt` or `customType` (grep, TESTED); how
  Squawk's mapper shows such a turn is NOT TESTED.
- `.codex/skills`, `.opencode/skills` and `.github/skills` are read only from the cwd itself; `.omp`,
  `.claude` and `.agents` are also read from ancestors.
- Without a tool flag the system prompt lists every non-hidden skill with the line
  `Matching skill → MUST read \`skill://<name>\` first.`, and long user-skill descriptions appear shortened
  there. That is the model-choice path (T5 and plain `/probe-alpha`).
- The October lead "skills with `requires` are dropped" holds on 18.13.1 for plugin skills only.
- User-level skills on this host come from `~/.agents/skills` and `~/.claude/plugins/cache`; the defaults
  `skills.enableClaudeUser` and `skills.enableCodexUser` are `false` (DOCS).

## Not tested, and why

- `OMP_PROFILE` and other home variables: the brief limits L2 to cwd.
- A trigger sent as a steer while a turn runs; a trigger with images: turn budget.
- Trigger of a namespaced (`claude/probe-dup`), plugin, colon or `hide:true` name: turn budget; list only.
- `$probe-alpha`: the source has no such syntax; no turn spent.
- Reference read under a narrowed `--tools` list without `read`: turn budget.
- `--plugin-dir` (hidden flag) and `omp skill list` with a config overlay: not needed for the two questions.
- Squawk's own handling of the `skill-prompt` frame (v1/v2 events, held-input release): outside a runner probe.
- Other models: every turn used `<provider>/gpt-5.6-luna`.

## Leftovers

omp wrote its own session files under `~/.omp/agent/sessions/` for the three probe directories (accepted by
the brief; not removed). Nothing else was written outside `/tmp`.

## Open checks, round 2 (2026-11-16)

omp 18.13.1, same transport as round 1. 2 model turns used (`<provider>/gpt-5.6-luna`), both for Check B.
Scratch root `/tmp/skill-probe-omp2.<rand>` with `repo/` (git, 3 project skills) and `home/` (scratch omp
root).

### Check A: does the skill list follow a non-default account home?

**How Squawk selects an omp account (DOCS, Squawk source).**

- `core/agent-profiles.ts` `ACCOUNT_LAYOUT.omp`: `select: { envVar: 'OMP_PROFILE', by: 'profile-name' }`,
  `configSubdir: 'agent'`. `profileEnv` emits `OMP_PROFILE=<name>`, the last path segment of an account
  folder that must be `<omp root>/profiles/<name>` (`workspace/agent-profiles.ts` `ompProfileDirError`).
- `<omp root>` is `~/<PI_CONFIG_DIR or .omp>` (`paths.ts` `ompRootDir`; omp `packages/utils/src/dirs.ts`
  agrees). The variable carries a name, never a path. The default account spawns with no variable.
- Squawk writes nothing into the profile folder: `core/agent-profiles.ts`, `workspace/agent-profiles.ts`
  and `workspace/agent-accounts.ts` hold no `mkdir`, `writeFile`, `symlink` or `copyFile` (grep).
- What the folder holds is omp's own: `agent/` (`agent.db`, `config.yml`, `models.yml`, `mcp.json`,
  `sessions/`, `skills/`), `logs/`, `run/`, `cache/` (`core/agent-profiles.ts` comments; the scratch run
  below created `agent/agent.db`, `agent/models.db`, `agent/skill-descriptions.db`, `agent/sessions/`,
  `logs/`).

**Test setup.** A profile under the real `~/.omp/profiles/` would be a write to the user home, so the scratch
profile sits under a scratch omp root reached with `PI_CONFIG_DIR=../../tmp/skill-probe-omp2.<rand>/home/omproot`
(omp joins it onto the home directory). `HOME` stayed real. Fixtures: one user skill in
`<root>/profiles/probea/agent/skills/home-probea-skill/`, one in `<root>/agent/skills/home-default-skill/`.
No credential file was copied or linked.

| Run (cwd = scratch repo) | Total | `native:user` | `agents:user` | `agent-plugins:user` | `claude-plugins:project` | project |
|---|---|---|---|---|---|---|
| 0. no variable (real default home) | 30 | 0 | 6 | 15 | 6 | 3 |
| 1. `PI_CONFIG_DIR=… OMP_PROFILE=probea` | 31 | 1 (`home-probea-skill`) | 6 | 15 | 6 | 3 |
| 2. `PI_CONFIG_DIR=…` only | 31 | 1 (`home-default-skill`) | 6 | 15 | 6 | 3 |

Command for each row: `omp skill list --json`, counted with
`jq '.skills|group_by(.source)|map("\(.[0].source)=\(length)")'`. TESTED, exit 0 in all three.

- **The scratch home's user skill appears**, as `native:user`, and only the selected profile's:
  run 1 lists `home-probea-skill` and not `home-default-skill`; run 2 the reverse. TESTED.
- **Nothing from the real home disappears.** The real default home has 0 skills of its own
  (`~/.omp/agent/skills` does not exist), so there was nothing omp-owned to lose. All 27 other user-level
  entries stay under the scratch profile: 6 from `~/.agents/skills`, 15 `agent-plugins:user` and 6
  `claude-plugins:project`, both from `~/.claude/plugins/cache`. Those sources hang off the home directory,
  not the omp home. TESTED.
- The 15 warnings (plugin skills dropped for `requires`, name collisions) are the same in all three runs.
  TESTED.
- **`omp skill list --json` works without a login in that home**: exit 0, empty stderr. TESTED.
- **RPC `get_available_commands` does not work without a usable model in that home.** TESTED:
  `PI_CONFIG_DIR=… OMP_PROFILE=probea omp --mode rpc` in the scratch repo exits 1 before the `ready` frame:

  ```
  No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.
  …
  Or create /tmp/skill-probe-omp2.<rand>/home/omproot/profiles/probea/agent/models.yml
  ```

  With a placeholder `OPENAI_API_KEY` in the child env (no prompt sent, so no model call) the same launch
  starts; `get_state` reports `openai/gpt-5.5` and a session file under
  `<root>/profiles/probea/agent/sessions/`, and `get_available_commands` returns 31 `source:"skill"` entries
  including `skill:home-probea-skill`, the same set as the CLI route. TESTED.
- DOCS, not tested: `managed-skills` (Skillshare installs) sits in the agent directory, so it follows the
  profile; so does `config.yml` with `skills.*` and `disabledExtensions`. Where omp's own plugin registry
  (`<omp root>/plugins/installed_plugins.json`) sits relative to a profile: NOT TESTED.
- NOT TESTED: `OMP_PROFILE` alone against the real `~/.omp` (it would create a folder in the user home).
  Run 2 shows that `PI_CONFIG_DIR` by itself only moves the root, so the profile effect in run 1 is the
  difference between runs 1 and 2.

### Check B: Squawk's omp adapter and UI mapper on a skill-triggered turn

**Recording (2 model turns, TESTED).** `omp --mode rpc --model <provider>/gpt-5.6-luna`, Squawk's four startup
commands with Squawk's ids, then `prompt` `cezar-prompt-1` = `/skill:probe-alpha` and, after
`session_settled`, `prompt` `cezar-prompt-2` = `/skill:probe-gamma second turn`. Raw stdout, both turns the
same shape (31 `message_update` lines and the startup frames left out, long values cut):

```
>>> {"type":"prompt","id":"cezar-prompt-1","message":"/skill:probe-alpha"}
{"id":"cezar-prompt-1","type":"response","command":"prompt","success":true}
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"custom","customType":"skill-prompt","content":"[IMPORTANT: User invoked the \"probe-alpha\" skill; …
{"type":"message_end","message":{"role":"custom","customType":"skill-prompt","content":"[IMPORTANT: User invoked …
{"type":"message_start","message":{"role":"assistant","content":[{"type":"thinking",…
{"type":"message_end","message":{"role":"assistant",… "ALPHA-c3a6081c" …
{"type":"turn_end","message":{"role":"assistant",…
{"type":"agent_end","messages":[{"role":"custom","customType":"skill-prompt",…
{"type":"prompt_result","id":"cezar-prompt-1","agentInvoked":true,"status":"completed","sessionSettled":true}
{"type":"session_settled"}
>>> {"type":"prompt","id":"cezar-prompt-2","message":"/skill:probe-gamma second turn"}
{"id":"cezar-prompt-2","type":"response","command":"prompt","success":true}
{"type":"agent_start"}
… same order, "probe-gamma", answer "GAMMA-f93e54cf: second turn" …
{"type":"session_settled"}
```

No line in the recording has `"role":"user"` (`grep -c` = 0).

**Replay through Squawk's real code (TESTED, no model call, repo unchanged).** A replay script stood in for
the binary: `new OmpRunner({ bin: <replay-omp.mjs> })` from `packages/cezar/src/core/omp-runner.ts`, loaded
with `node --import tsx` from `packages/cezar` (the runner the repo's own scripts use). The script writes the
recorded frames back in the recorded order as each command arrives on stdin. The harness called
`startSession({ cwd, userPrompt: '/skill:probe-alpha', toolGrant: { kind: 'unset' } })`, printed every v1
`AgentEvent` and every `UiEvent`, and sent the second prompt at the first `turn-end`, once with
`session.sendMessage` and once with `session.sendAgentMessage(…, ['input-A'])`.

What the adapter wrote to the child: argv `["--mode","rpc"]`, then exactly the recorded commands, including
`{"type":"prompt","id":"cezar-prompt-1","message":"/skill:probe-alpha"}`. So Squawk passes the trigger text
through unchanged.

What Squawk emitted (deltas left out; identical in both runs except the marked lines):

```
ui  {"type":"turn.started","turnId":"turn_1"}
ui  {"type":"session.started","sessionId":"01a1e47c-…","backend":"omp","model":"gpt-5.6-luna"}
v1  {"type":"session","sessionId":"01a1e47c-…"}
ui  {"type":"item.completed","item":{"kind":"reasoning","id":"turn_1_reasoning_0_0",…}}
ui  {"type":"item.completed","item":{"kind":"message","id":"turn_1_text_1_0","role":"assistant","text":"ALPHA-c3a6081c"}}
v1  {"type":"text","text":"ALPHA-c3a6081c"}
ui  {"type":"usage.updated",…}   v1 {"type":"token-usage","tokensUsed":8619}   v1 {"type":"cost","usd":0}
ui  {"type":"turn.completed","turnId":"turn_1","stopReason":"end_turn",…}   [holdsHumanInput=false held=0]
v1  {"type":"turn-end"}
ui  {"type":"turn.started","turnId":"turn_2"}
ui  {"type":"item.completed","item":{"kind":"message","id":"turn_2_text_1_0","role":"assistant","text":"GAMMA-f93e54cf: second turn"}}
v1  {"type":"text","text":"GAMMA-f93e54cf: second turn"}
ui  {"type":"turn.completed","turnId":"turn_2","stopReason":"end_turn",…}
--  onAgentInputConsumed ["input-A"]          (agent run only)
v1  {"type":"turn-end"}
ui  {"type":"session.ended","reason":"end_turn"}
v1  {"type":"done"}
result {"text":"ALPHA-c3a6081c\nGAMMA-f93e54cf: second turn","toolCalls":[],"tokensUsed":10424,"sessionId":"01a1e47c-…"}
```

| Question | Answer |
|---|---|
| Does Squawk see a user message for the turn? | No event of either stream carries the prompt or the skill body. The mapper only makes items for `role:"assistant"` (`omp-ui-mapper.ts` `mapMessageEnd`, `isAssistantMessageEnd`), so an ordinary `user` message makes no item either: the adapter is not where Squawk's user bubble comes from. TESTED for the skill turn, DOCS for the comparison. |
| Turn start | Detected: `turn.started` for both turns. The adapter emits it itself when it writes the prompt (`ompTurnStarted`), not from an omp frame. TESTED. |
| Turn end | Detected: `turn.completed` and v1 `turn-end` at `session_settled`, both turns. TESTED. |
| Session id | Recorded: `session.started`, v1 `session`, and `result.sessionId`, from the `get_state` response. TESTED. |
| Skill body shown as assistant text? | No. The `custom` `message_start` and `message_end` produce nothing in v1 or v2; `result.text` holds only the two answers. TESTED. |
| Held human input | Released: `holdsHumanInput()` is `true` after the write and `false` at `turn.completed` in both turns. With no `user` `message_start` to match, the release comes from the prompt's `response` while the turn it opened is open (`settleHumanAck`), and `prompt_result` would release it otherwise. TESTED for the outcome, DOCS for the branch. |
| Agent-sent input (`sendAgentMessage`) | The receipt is acknowledged and `onAgentInputConsumed(["input-A"])` fires, but at the turn's end (`PiRpcInput.settleTurn`, the "carried" path) and not when the model received the prompt, because the `user` `message_start` that normally reports it never comes. TESTED. |
| Dropped or mis-shown | Dropped: the whole `skill-prompt` message, so Squawk's streams carry no trace of which skill ran, its path or its arguments (`details.name`, `details.path`, `details.args` are in the raw frame only). Nothing was mis-shown and no turn was left unstarted or unended. TESTED. |

Branch each recorded frame type takes (DOCS, `omp-runner.ts` `handleOutputLine` → `mapOmpRpcMessage` and
`dispatchNative`/`dispatchPiTurnMessage`):

- `ready`, `advisor_cost_changed`, `available_commands_update`, `extension_ui_request`, `turn_start`,
  `turn_end`, `agent_end`: mapper `default` (nothing); the first frame releases the adapter's outbox.
- `response` to `get_state`: session id adopted. To `set_*`: a note only on failure. To `prompt`:
  `settlePromptResponse`, which settles the human or agent acknowledgement.
- `agent_start`: `PiRpcInput.startTurn` (marks acknowledged agent input as carried).
- `message_start` with `role:"custom"`: `dispatchPiTurnMessage` handles only `role === 'user'`; nothing.
- `message_end` with `role:"custom"`: not an assistant message; nothing in mapper or dispatcher.
- `message_update`, assistant `message_end`: text and reasoning items, usage, v1 `text`.
- `prompt_result` (`completed`): removes the held human prompt; no event.
- `session_settled`: `completeTurn` → `turn.completed`, then `settleTurn` → v1 `turn-end`.

NOT TESTED: a skill trigger sent as a steer while a turn runs. DOCS reading: an agent-sent steer is consumed
only by a matching `user` `message_start` or by being carried from before `agent_start`; a skill-expanded
steer has neither, so whether its input id is ever reported as consumed is open. Also NOT TESTED: how the
run pipeline above the adapter (transcript, cockpit) shows the turn; this check stopped at the adapter's
two event streams.

### Leftovers, round 2

omp wrote one more session folder of its own under `~/.omp/agent/sessions/` (the scratch repo, default-home
runs). Scratch folders under `/tmp` removed; no process started by the probe is left.

## Slice 1 list seam checks (2026-11-16)

omp 18.13.1. No model call. Reproduce:

```
node .ai/analysis/2026-11-16-runner-native-skills/slice1-open-checks.mjs omp
node --import tsx .ai/analysis/2026-11-16-runner-native-skills/slice1-probe.mjs omp
```

**TESTED: OMP_PROFILE against the real omp root.** A unique owned profile under
`~/.omp/profiles/squawk-list-probe-<timestamp>/agent/skills/probe-profile` held a single
fixture. `OMP_PROFILE=<name> omp skill list --json` returned:

```json
{"name":"probe-profile","description":"Profile probe.","filePath":"<root>/profiles/<name>/agent/skills/probe-profile/SKILL.md","source":"native:user"}
```

It listed 28 skills and 15 warnings, with no login in that profile. The probe removed only
its owned profile after exit. Other user and plugin sources under HOME remained visible,
as in round 2. `profileEnv('omp', '<root>/profiles/<name>')` sends that exact profile name.

Implemented adapter output (271 ms, 28 skills, trimmed):

```json
{"runner":"omp","source":"live","skills":[{"id":"probe-project","name":"probe-project","path":"<repo>/.omp/skills/probe-project/SKILL.md","scope":"repo"},{"id":"audit-agent-readiness","name":"audit-agent-readiness","path":"<home>/.claude/plugins/cache/.../SKILL.md","scope":"user","plugin":"agent-plugins"}],"problems":[{"message":"[Agent Plugins] ... unexpected frontmatter field ..."}]}
```

Real native response excerpt: `core/__fixtures__/omp/skill-list.json` under the service
workspace. The adapter keeps native warnings as problems and does not read a skill body.

## Slice 2 trigger checks (2026-11-16)

omp 18.13.1, `cliproxy/gpt-5.6-luna`. The check sent `/skill:probe-project fixture
arguments` on the first native assistant/stream frame. It returned the random fixture token
without tools in 24109 ms, within one turn boundary. Two real prompts were used. The native
`message_start` carries a custom `skill-prompt`; `details.prompt` contains the user trigger.
`skillTriggerMidTurn` is true.

The mapper emits one user item on `message_start`, ignores repeated end payloads, and the
RPC turn handler releases the input hold like an ordinary user message. The golden fixture
`skill-trigger.expected.json` is pinned by `omp-ui-mapper.test.ts`, persisted without duplicate
items by `runs/ui-event-sink.test.ts`, and rendered once by
`web/src/routes/task-thread/session-transcript.test.tsx`.

See [slice 2 evidence](slice2-evidence.md) for commands, captures and offline checks.
