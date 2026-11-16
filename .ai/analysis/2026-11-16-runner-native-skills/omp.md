# omp: native skill listing and native skill trigger

Probe date 2026-11-16. Runner: **omp (oh-my-pi) 18.13.1**, binary `~/.local/bin/omp` (a compiled
Bun executable; "source" below means the JavaScript read out of that binary with `strings`, file names from
its `// packages/...` comments). Default account, no `OMP_PROFILE`. The user config has no `skills.*` and no
`disabledExtensions` key, so omp's defaults applied.

Model: `cliproxy/gpt-5.6-luna` (`--model`), the smallest tier of the default account's subscription proxy. The
account's own default model was `cliproxy/gpt-6.1-sol`. 12 model turns used, 0 timeouts. The model followed
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
 "warnings":[{"skillPath":"","message":"… Skipping skill \"dev-flow\": unexpected frontmatter field \"requires\""}, …]}
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
  plugin gave `squeal`, `squeal/squeal`, `squeal/squeal~2`, `squeal/squeal~3`. TESTED for the list.

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
- Other models: every turn used `cliproxy/gpt-5.6-luna`.

## Leftovers

omp wrote its own session files under `~/.omp/agent/sessions/` for the three probe directories (accepted by
the brief; not removed). Nothing else was written outside `/tmp`.
