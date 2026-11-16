# Skill probe: claude

- Runner: Claude Code CLI `2.1.321` (`claude --version`), binary `claude`, default account, model `haiku` (resolved to `claude-haiku-5-5` in `system/init`).
- Date: 2026-11-16. Model turns used: 12 of 12. Every other probe made no model call (`num_turns: 0`, `total_cost_usd: 0`, or a control request).
- Fixture: scratch git repo `/tmp/skill-probe-claude.XXXXXX` with `.claude/skills/probe-alpha` (+ `references/extra.md`), `.claude/skills/probe-gamma`, and a detector `.agents/skills/probe-delta`. Later additions for name rules are listed where used. A session-only fixture plugin (`--plugin-dir`, outside the repo) covered plugin-qualified names. Nothing was written to `~/.claude` by me; Claude itself wrote session transcripts under `~/.claude/projects/-tmp-skill-probe-claude-*`.
- Nested start: `claude` started inside this Claude Code session with the inherited environment unchanged. No variable blocked it.

## Step 0: how Squawk drives Claude (from the adapter)

Source: `packages/cezar/src/core/claude-cli-runner.ts` (`buildClaudeArgs`, `sendMessage`), `claude-stream.ts`, `agent-profiles.ts`, `workflows/types.ts`.

- Transport: one long-lived child process, NDJSON on stdin and stdout. Argv:
  `--input-format stream-json --output-format stream-json --verbose [--replay-user-messages] [--include-hook-events] --permission-mode dontAsk --settings '{"crossSessionInbound":"refuse"}' [--setting-sources <v>] [--append-system-prompt <text>] --session-id <uuid> | --resume <uuid> [--tools ""] [--mcp-config <json>] [--allowedTools <list>] [--model <m>] [--effort <e>] [--add-dir <dir>]...`
- Permission mode: `dontAsk` by default; `HSQ_/CEZ_CLAUDE_PERMISSION_MODE` selects `dontAsk`, `acceptEdits` or `bypass` (`--dangerously-skip-permissions`); `APPROVAL_GATE=1` gives `acceptEdits`.
- Tools: `--allowedTools` from the tool grant. The default list is `Read,Edit,Write,Grep,Glob,Bash` (`DEFAULT_ALLOWED_TOOLS`) plus Squawk's own `mcp__<name>__*` tools. An unset grant sends no flag. An empty grant sends `--tools ""`.
- Settings: `HSQ_/CEZ_CLAUDE_SETTING_SOURCES`, when set, becomes `--setting-sources`. Both `CEZ_CLAUDE_PERMISSION_MODE` and `CEZ_CLAUDE_SETTING_SOURCES` exist in this task's environment (names only; values not read).
- First prompt and every later message use the same stdin line (`sendMessage`):
  `{"type":"user","uuid":"<uuid>","message":{"role":"user","content":[...images,{"type":"text","text":"<prompt>"}]},"session_id":"<id>"}`
- Continue: a new process with `--resume <sessionId>`.
- Non-default account: `CLAUDE_CONFIG_DIR` (`agent-profiles.ts:39`).
- The adapter sends no `control_request`. Squawk's model catalog (`claude-model-catalog.ts`) already does, on a separate probe process: `--print --input-format stream-json --output-format stream-json --verbose --safe-mode --no-session-persistence` + `{"type":"control_request","request":{"subtype":"list_models"}}`.

All probes below used: `--input-format stream-json --output-format stream-json --verbose --replay-user-messages --include-hook-events --settings '{"crossSessionInbound":"refuse"}' --permission-mode dontAsk --allowedTools Read,Edit,Write,Grep,Glob,Bash --model haiku --session-id <uuid>`, cwd = scratch repo, user lines in Squawk's shape (content = block array). Not included: `--append-system-prompt`, `--mcp-config`. Deviations are named per row.

## Results

| # | Verdict | Evidence |
|---|---|---|
| L1 | **YES, three no-model routes.** All need a running `claude` process in stream-json mode; none needs a model session. None returns a file path. | See "L1 detail". |
| L2 | **cwd-sensitive: yes. Setting sources: yes.** Config-dir variable not tested (brief: cwd only). | See "L2 detail". |
| T1 | **YES: `/probe-alpha` as the text of the user line. The runner expands it; the model makes no choice.** | See "T1 detail". |
| T2 | **YES.** Arguments reach the skill. | TESTED (turn 2): sent `/probe-alpha hello world` → result `ALPHA-ca6cb024:hello world`, `num_turns: 1`. Transcript meta message ends with `ARGUMENTS: hello world` (the skill has no `$ARGUMENTS` placeholder). Replay: `<command-args>hello world</command-args>`. |
| T3 | **Model choice, not runner expansion.** | TESTED (turn 6): sent `Say hi, then run /probe-alpha` → replay is the raw text; `assistant text:Hi!`, then `tool_use:Skill {"skill":"probe-alpha"}`, `tool_result: Launching skill: probe-alpha`, a `user isSynthetic=true` message with the body, then `ALPHA-ca6cb024`. `num_turns: 3`. |
| T4 | **Plain text to the model. No error event.** | TESTED (turn 5): sent `/probe-nope` → replay `"/probe-nope"` (raw string, no `<command-name>` tags), no error or system event; the model answered "`/probe-nope` isn't installed in this session…". `is_error: false`, `num_turns: 1`. |
| T5 | **Works, by model choice, through the `Skill` tool.** | TESTED (turn 7): sent `Use the probe-gamma skill.` → `tool_use:Skill {"skill":"probe-gamma"}` → synthetic user message with body → `GAMMA-6525b0a4`. `Skill` is not in `--allowedTools`; `permission_denials: []`. |
| T6 | **YES under Squawk's default launch.** Inside cwd a read needs no allow rule. Outside cwd it needs `Read` in the allow list or `allowed-tools: Read` in the skill. | See "T6 detail". |
| T7 | **YES, second turn and after resume.** | TESTED: turn 2 of the same process (T2 row). TESTED (turn 4): new process with `--resume <same id>`, sent `/probe-gamma resumed` → `GAMMA-6525b0a4:resumed`, `num_turns: 1`, `init.session_id` equal to the resumed id. |
| T8 | **YES if `.claude/skills/` existed at session start. NO if the folder itself is new, until `/reload-skills` or a new process.** | See "T8 detail". |

### L1 detail

Route A, user line `/reload-plugins` (TESTED; the October lead holds on 2.1.321):
```
stdin:  {"type":"user","uuid":"…","message":{"role":"user","content":[{"type":"text","text":"/reload-plugins"}]},"session_id":"…"}
stdout: system/init  … "skills":[…55 strings…], "slash_commands":[…89 strings…], "plugins":[{"name","path","source","version"}…]
        result/success num_turns=0 cost=0 result="Reloaded: 3 plugins · 29 skills · 5 agents · 12 hooks · 0 plugin LSP servers"
timing: init at 1.2 s, process exit at 1.6 s
```
- `skills` and `slash_commands` are arrays of **names only**. `plugins` entries carry `name, path, source, version`.
- `skills` holds project skills (`probe-alpha`, `probe-gamma`), user skills (7), plugin skills as `plugin:skill` (28) and bundled skills (18, for example `dataviz`, `update-config`).
- `system/init` is emitted at the start of every turn (3 turns → 3 `init` events), not at process start. A process that gets no user line emits no `init`.
- This route writes a session transcript to `~/.claude/projects/<cwd-slug>/<sid>.jsonl`. With `--no-session-persistence` added to the same stream-json argv it writes none (TESTED), although `--help` says the flag "only works with --print".

Route B, control request `get_skills_dialog` (TESTED; the subtype name comes from the binary's strings, I found no public doc for it):
```
stdin:  {"type":"control_request","request_id":"r1","request":{"subtype":"get_skills_dialog"}}
stdout: {"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"skills":[
  {"name":"probe-alpha","display_name":"probe-alpha","description":"First fixture skill for a transport check.","source":"project","tokens":18,"state":"on","advertised":true,"handles":{}},
  {"name":"squeal:setup","display_name":"squeal:setup","description":"…","source":"plugin","tokens":83,"state":"on","locked_by":"plugin","advertised":true,"handles":{"aliases":["setup"]}}, …]}}}
timing: response at 0.4–0.5 s after spawn; no user line needed; no session file written
```
- Fields: `name, display_name, description, source (project|user|plugin), tokens, state, advertised, handles.aliases, locked_by`. No path.
- 37 entries: project 2, user 7, plugin 28. Bundled skills are not in it. A `.claude/commands/*.md` file is in it (`source: project`) although `init.skills` omits it.

Route C, control request `initialize` (TESTED):
```
stdin:  {"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}
stdout: control_response … "commands":[{"name":"probe-alpha","description":"First fixture skill for a transport check. (project)","argumentHint":""}, …89…]
timing: 0.8 s
```
- `commands` entries: `name, description, argumentHint`, optional `aliases`, optional `builtin: true`. Scope is only a text suffix or prefix in `description`: ` (project)`, ` (user)`, `(plugin-name) …`. It mixes skills with built-in commands (`clear`, `compact`, …).
- The same response has an `account` object and other session data. I did not print it.
- Same entry shape from: control `reload_skills` → `{skills:[…51…]}`, control `reload_plugins` → `{commands, agents, plugins, mcpServers, error_count}`, and the pushed event `system/commands_changed` → `{commands:[…]}` (seen in T8).

Common to all three (TESTED):
- User `SessionStart` hooks run on every list probe (`system/hook_started` ×2 in each capture).
- `--safe-mode` (the model catalog's flag) empties the list: `get_skills_dialog` → `skills: []`. `--print --no-session-persistence` without `--safe-mode` → 46 entries.
- `.agents/skills/probe-delta` is in no list. Claude reads `.claude/skills` and `.claude/commands`, not `.agents/skills`.

### L2 detail (all TESTED, free)

| Launch | `probe-*` in list |
|---|---|
| cwd = repo root | project skills listed; `sub/.claude/skills/probe-nested` **not** listed |
| cwd = `repo/sub` | `probe-nested` **and** the root's skills listed |
| cwd = unrelated empty folder | none (`init.skills` 53 vs 60) |
| unrelated cwd + `--add-dir <repo>` | the repo's project skills listed, `source: project` |
| repo root + `--setting-sources user` | none |
| repo root + `--setting-sources project` | project skills listed; user skills and installed plugins gone (`Reloaded: 0 plugins · 0 skills`, `init.skills` 25) |

`CLAUDE_CONFIG_DIR`: NOT TESTED. DOCS: personal skills live in `~/.claude/skills/` ([skills doc](https://code.claude.com/docs/en/skills.md), "Where skills live").

### T1 detail

TESTED (turn 1), Squawk argv and line shape:
```
stdin:  …"content":[{"type":"text","text":"/probe-alpha"}]…
stdout: user isReplay=true  content="<command-message>probe-alpha</command-message>\n<command-name>/probe-alpha</command-name>"
        assistant text: ALPHA-ca6cb024
        result/success num_turns=1 denials=[]            (no tool_use of any kind)
session JSONL: {"type":"user","isMeta":true,"message":{"content":[{"type":"text","text":
        "Base directory for this skill: /tmp/skill-probe-claude.…/.claude/skills/probe-alpha\n\nReply with exactly this token…"}]}}
```
The runner loaded the body. The expanded body is **not** on stdout; the only stdout sign of expansion is the replayed user message, whose content becomes a string with `<command-message>`/`<command-name>` tags (needs `--replay-user-messages`). A message that was not expanded is replayed unchanged.

Input forms. "Free" rows used `--model probe-no-such-model-0`: the request fails with `API Error: 400 unknown provider for model …`, `cost 0`, `output_tokens 0`, and the replay plus the session JSONL still show whether the runner expanded the line.

| Form | Runner expanded? | How tested |
|---|---|---|
| `/probe-alpha` (whole text) | yes | model turn 1 |
| `/probe-alpha hello world` | yes, with args | model turn 2 |
| `/probe-alpha first line\nsecond line` | yes; args = `first line\nsecond line` | free |
| `/probe-alpha\n\nsecond paragraph` | yes; args = `second paragraph` | free |
| content as a plain string instead of a block array | yes | free |
| `[image block, text "/probe-alpha …"]` (Squawk's shape with images) | yes; the image is kept | free |
| `[text "context first", text "/probe-alpha …"]` | yes; the first block is kept before the body | free |
| `[text "/probe-alpha …", text "second block"]` | **no**; replayed raw | free |
| ` /probe-alpha` (leading space), `\n/probe-alpha` (leading newline) | **no** | free |
| `/PROBE-ALPHA` | **no** (case-sensitive) | free |
| `$probe-alpha` | **no**; raw text to the model | free |
| `/skill:probe-alpha` | **no**; raw text to the model (same class as T4) | free |
| `/probe-plug:probe-zeta` (plugin-qualified, `--plugin-dir`) | yes | free |
| `/probe-zeta` (bare name of a plugin skill, listed as alias) | yes, resolves to `probe-plug:probe-zeta` | free |
| `/probe-cmd legacy args` (`.claude/commands/probe-cmd.md`) | yes; `$ARGUMENTS` substituted | free |
| structured skill item / dedicated request | no such input found in `--help` or in the stream; NOT TESTED | - |

Launch variants (free):
- `--tools ""` (Squawk's empty grant): `/probe-alpha` still expands.
- `--disable-slash-commands`: `/probe-alpha` is replayed raw; no expansion.
- `claude -p "/probe-alpha pmode" --output-format stream-json --verbose` (print mode): expands the same way (session JSONL has the `isMeta` body). Print mode without `--replay-user-messages` shows no replay, so stdout gives no sign of expansion.
- DOCS: "User-invoked skills and custom commands work. Include `/skill-name` in the prompt string and Claude Code expands it before running." ([headless doc](https://code.claude.com/docs/en/headless.md)).

### T6 detail (TESTED)

| Skill location | Launch | Result |
|---|---|---|
| project, inside cwd | Squawk default list (turn 3, after `/probe-alpha`, asked "What is the extra token?") | `tool_use:Read …/probe-alpha/references/extra.md` → `BETA-8b1a55be`, `denials: []` |
| project, inside cwd | `--allowedTools Glob` (no `Read`), turn 9 | Read allowed → `REF-edaef5cb`, `denials: []` |
| plugin dir outside cwd | `--allowedTools Glob` (no `Read`), turn 10 | `system/permission_denied … "Permission to use Read has been denied because Claude Code is running in don't ask mode"` → `CANNOT-READ` |
| plugin dir outside cwd | Squawk default list, turn 11 | Read allowed → `PLUGREF-70a8fcea` |
| plugin dir outside cwd, skill has `allowed-tools: Read` | `--allowedTools Glob`, turn 12 | Read allowed → `PLUGGRANT-9d4cd312` |

The model resolved `references/extra.md` against the "Base directory for this skill" line in every case.

### T8 detail

- TESTED (turn 8), `.claude/skills/` existed at start: after a free first line, I created `.claude/skills/probe-late/SKILL.md`. Within 4 s `get_skills_dialog` listed `probe-late` and stdout carried `system/commands_changed` with the full new command list. Then `/probe-late now` → `LATE-01e893c9:now`, `num_turns: 1`, runner expansion.
- TESTED (free), `.claude/skills/` did **not** exist at start: after creating `.claude/skills/probe-fresh/`, `get_skills_dialog` did not list it 5 s later and `/probe-fresh one` was replayed raw (not expanded). User line `/reload-skills` → `result num_turns=0 cost=0 "Reloaded skills: 50 skills available (1 added)."`; then the list had it and `/probe-fresh two` expanded.
- TESTED (free): a new process with `--resume <id of a session started before probe-late existed>` lists `probe-late`.
- DOCS: both behaviours match "Live change detection" in the [skills doc](https://code.claude.com/docs/en/skills.md).

## Name rules, duplicates, plugin names

- TESTED: the listed `name` is the **folder** name; frontmatter `name` is `display_name`. Folder `probe-mismatch-dir` with `name: probe-renamed` lists as `name: probe-mismatch-dir, display_name: probe-renamed`. Both `/probe-mismatch-dir` and `/probe-renamed` expand that skill. `init.skills` and `slash_commands` show only the folder name.
- TESTED: no charset rule was enforced on these fixtures. Folder `Probe_Upper` with no `name` field lists and expands as `/Probe_Upper`. `name: "Probe Bad:Name"` stays listed (as display name) and `/probe-badname` expands.
- TESTED: two folders `probe-dup-a` and `probe-dup-b`, both `name: probe-dup`: both listed under their folder names with the same display name; `/probe-dup` silently expands `probe-dup-a`. No warning in the stream.
- TESTED: a plugin skill lists as `plugin:skill` with `handles.aliases: ["skill"]`. When a project skill has the same bare name, the plugin entry has no alias, `/probe-alpha` runs the project skill and `/probe-plug:probe-alpha` runs the plugin's.
- DOCS ([skills doc](https://code.claude.com/docs/en/skills.md), "Same name in / Which one runs"): enterprise over personal, personal over project; a skill wins over a `.claude/commands` file; plugin skills never clash because of the namespace. Refused in names: `<`, `>`, control and zero-width characters, odd blanks.
- DOCS: `disable-model-invocation: true` keeps `/name` and blocks the model path; `user-invocable: false` blocks `/name`. Neither was tested.

## Surprises

1. Expansion looks only at the **last text block** and needs `/` as its first character. A leading space or newline, or a second text block after the command, turns the trigger into plain text for the model, with no error.
2. An unknown or unexpanded `/name` gives no error event. The model just gets the text. The replayed user message is the only stream signal that tells the two cases apart.
3. The runner-expanded skill body never appears on stdout (only in the session JSONL as an `isMeta` user message). The model-chosen `Skill` tool path does put the body on stdout, as a `user` message with `isSynthetic: true`.
4. `system/init.skills` has names only. Descriptions and source need a control request, which Squawk's session adapter does not send today.
5. The three list routes disagree on membership: `init.skills` 55, `get_skills_dialog` 37 (no bundled skills, includes command files), `initialize.commands` 89 (all slash commands), `reload_skills` 51. The `/reload-plugins` result text says "29 skills".
6. Frontmatter `name` is a second trigger name, and duplicate display names resolve silently to one folder.
7. `--setting-sources project` removes installed plugins and user skills; `--setting-sources user` removes project skills. Squawk forwards this flag from an env variable.
8. The `Skill` tool runs under `dontAsk` without being in `--allowedTools`.
9. Reads inside cwd are allowed without `Read` in the allow list; only reads outside cwd depend on it.
10. A skill folder is hot-loaded mid-session only when `.claude/skills/` already existed at start.
11. User hooks fire on list probes (`SessionStart`) and on every turn (`UserPromptSubmit`, `Stop`), so a list probe is not side-effect free on a host with hooks. `--safe-mode` removes the hooks and the skills together.
12. Two installed plugins here both list the alias `setup` (`apptension-sdlc:setup`, `squeal:setup`). Which one `/setup` runs was not tested.

## Not tested, and why

- `CLAUDE_CONFIG_DIR` and personal-over-project precedence: the brief limits L2 to cwd, and a personal skill needs a write to the user home.
- `$probe-alpha` and `/skill:probe-alpha` with a real model: turn budget. The free check shows the runner does not expand them; whether the model then picks the `Skill` tool is unknown.
- A `/name` line written while a turn is running (Squawk merges such a line into the running turn): turn budget.
- `acceptEdits` and `bypass` permission modes, and the launch with `--append-system-prompt` and `--mcp-config`: not expected to change expansion; not run.
- `context: fork`, `disable-model-invocation`, `user-invocable: false`: excluded by the task or DOCS only.
- Whether the list routes answer on a logged-out account.
- A structured skill input or a dedicated "run skill" control request: none found in `--help`; the binary's control subtypes include `get_skills_dialog`, `reload_skills`, `reload_plugins`, `local_command`, and I tested only the first three.
- Caveat on the free expansion probe: the zero-cost failure for a made-up model id came from this host's API proxy (`400 unknown provider`). On another host the error text may differ.
