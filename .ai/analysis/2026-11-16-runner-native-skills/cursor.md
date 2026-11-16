# Cursor: native skill listing and trigger probe

- Runner: Cursor CLI **`2026.11.13-eacade1`** (`agent`, `cursor-agent`). The task named `2026.10.22-27dcf5f`;
  the CLI replaced itself at 2026-11-16 12:43:21, 18 s after the login rewrote `~/.config/cursor/auth.json`
  (file timestamps). All live tests below ran on `2026.11.13`. Source claims were first read in the
  `2026.10.22` bundle; the resolver, loader and init-frame code are the same text in `2026.11.13` (re-read).
- Probe date: 2026-11-16. Model: `gpt-5.4-nano-low` (cheapest by name in `agent --list-models`; the list shows
  no prices). Model turns used: 12 of 12. Load average 6 to 8; no timeout, no retry.
- **LIST: no route in Squawk's transport.** Print mode has no list command and no list in its frames. ACP
  (not Squawk's transport) lists commands and skills without a model call, but leaves out plugin skills.
- **TRIGGER: yes.** `/<skill folder name>` anywhere in the stdin text, after start-of-text or whitespace,
  makes the CLI attach that skill's `SKILL.md` to the turn. 9 of 9 trigger turns (1, 2, 3, 6, 7, 8, 9, 11, 12)
  returned the token with zero `tool_call` frames in the stream.

## Step 0: how Squawk drives Cursor (read from the adapter)

- **Transport: print mode only.** `cursor-runner.ts` runs every session on `CursorPrintRunner`. ACP was
  removed (hearsay-tools/cezarion#1267); an ACP resume is refused. `cursor-print-capabilities.ts` accepts any
  dated build `>= 2026.10.01` whose `--allowed-tools` validator lists the core tools, so the October
  "one exact build, else ACP" rule no longer exists.
- **argv per turn** (`cursor-print-runner.ts`, `beginTurn`): `agent --disable-auto-update -p --force --trust
  --output-format stream-json [--model <id>] [--resume <nativeId>] [--add-dir <dir>]... [--plugin-dir
  <private squawk-tools plugin>] [--image <path>]...`, cwd = task worktree, one new process per turn.
- **Prompt:** written to stdin, then stdin closes. The text is `"<systemPrompt>\n\n---\n\n<userPrompt>"` on
  every turn (`prependSystemPrompt`). Later messages and Continue: a new process with `--resume <session_id
  from the init frame>`.
- **Tool and settings limits:** none (`cursorPrintToolGrantArgs` returns `[]`); `--force --trust` always.
  Env: `buildChildEnv({backend: 'cursor'})` passes `CURSOR_*`. No named accounts
  (`ACCOUNT_LAYOUT.cursor.select = null`); `CURSOR_CONFIG_DIR` is passed through only when already set.
- After each process exits Squawk signals its process group, which ends `worker-server`.

Probe command for every model turn, from the scratch repo (prompt on stdin, no trailing newline):
`agent --disable-auto-update -p --force --trust --output-format stream-json --model gpt-5.4-nano-low [--resume <id>]`.
Not used: `--plugin-dir`, `--add-dir`, `--image`.

## Fixture

Scratch git repo under `/tmp`, one commit. Each `SKILL.md` has `name`, a description without the token, and
"Reply with exactly this token and nothing else: X. If the user gave arguments, append them after a colon."

| Folder | Frontmatter `name` | Token |
| --- | --- | --- |
| `.cursor/skills/probe-alpha` (+ `references/extra.md` = `BETA-989bff02`) | probe-alpha | `ALPHA-142ca8c5` |
| `.cursor/skills/probe-gamma` | probe-gamma | `GAMMA-20e5daa8` |
| `.cursor/skills/probe-one` | **probe-two** | `FOLDERONE-5830ce8c` |
| `.cursor/skills/probe-two` | **probe-one** | `FOLDERTWO-d32a695f` |
| `.claude/skills/probe-claude-dir` | probe-claude-dir | `DIRCLAUDE-32d8ed31` |
| `.agents/skills/probe-agents-dir` | probe-agents-dir | `DIRAGENTS-7c6434b1` |
| `.codex/skills/probe-codex-dir` | probe-codex-dir | `DIRCODEX-c2402d14` |
| `.grok/skills/probe-grok-dir` | probe-grok-dir | `DIRGROK-daa3aff4` |
| `.cursor/skills/probe-late` (added after turn 10, uncommitted) | probe-late | `LATE-cbcb2463` |
| `.agents/skills/probe-alpha` (added after turn 11, uncommitted) | probe-alpha | `ALPHADUP-fa25ca2d` |

## Results

Frame lists show every stream-json frame of the turn as `type/subtype`; thinking deltas are left out.

| # | Verdict | Evidence |
| --- | --- | --- |
| **L1** list without a model call | **Print: none (TESTED). ACP: yes, partial (TESTED, not Squawk's transport).** | Print: `agent --help` on 2026.11.13 lists `persist install-shell-integration uninstall-shell-integration login logout mcp plugin worker status models team bedrock about update create-chat generate-rule agent ls resume help`; no line of `--help` contains "skill". The init frame of all 12 turns has exactly `type, subtype, apiKeySource, cwd, session_id, model, permissionMode`. Frame types seen in all turns: `system/init`, `user`, `thinking`, `assistant`, `tool_call`, `result`; none carries a skill list. ACP: `agent --disable-auto-update acp`, then `initialize`, `authenticate {methodId:"cursor_login"}`, `session/new {cwd, mcpServers:[]}`; one `session/update` with `sessionUpdate:"available_commands_update"` arrived 2.8 to 3.5 s after `session/new` (4.6 to 8.9 s after process start), no prompt sent. Shape: `availableCommands: [{name, description}]`; the description ends in `(project skill)`, `(user skill)`, `(builtin skill)` or `(global)`. No path. In the scratch repo: 40 entries = `copy-request-id` + 6 global commands + 18 builtin skills + 9 project skills (all `probe-*`) + 6 user skills (names omitted). **Plugin skills are not in it**: `<plugin-skill-a>` (in `~/.cursor/plugins/cache/...`) is absent, while the print model named that skill in T5. Closest no-CLI source for print: list the folders in L2. |
| **L2** cwd and home sensitivity | **cwd: yes (TESTED, ACP). Home variable: NOT TESTED.** | Same ACP request with cwd = an empty non-git folder: 27 entries, 0 `probe-*`, the 6 user skills still there, and 3 git-only global commands gone. Print resolves project skills from the cwd (all trigger turns). DOCS (bundle, `loadCommands`): user roots hang off the OS home dir, not `CURSOR_CONFIG_DIR`; Squawk sets no account variable for Cursor. |
| **T1** explicit trigger | **TESTED: `/probe-alpha` as the whole message works; the RUNNER attaches the body.** | Turn 1, stdin `/probe-alpha`: frames `system/init`, `user` (text `/probe-alpha`, unchanged), `assistant` = `ALPHA-142ca8c5`, `result/success`. No `tool_call` frame. Control that bodies are not always in context: turn 8 asked for every token whose full skill text was visible and got only the four referenced ones; turn 5 (prose) needed a read tool. `$probe-alpha`, `/skill:probe-alpha`: NOT TESTED (turn budget); DOCS: the resolver regex is `(?:^\|\s)\/([a-zA-Z0-9_-]+)` only. No structured skill item exists in print (stdin text only). |
| **T2** arguments | **TESTED: yes, as plain prompt text.** | Turn 2, stdin `<system text>\n\n---\n\n/probe-alpha hello world` (Squawk's shape): `assistant` = `ALPHA-142ca8c5:hello world`, no `tool_call`. Turn 9: `/probe-gamma second turn` gave `GAMMA-20e5daa8:second turn`. The `user` frame shows the text unchanged, so the model reads the arguments from the prompt; no substitution was observed. |
| **T3** mid-text | **TESTED: runner expansion.** | Turn 3, stdin `Say hi, then run /probe-gamma`: `assistant` = `GAMMA-20e5daa8`, no `tool_call`. |
| **T4** unknown name | **TESTED: plain text to the model, silent.** | Turn 4, stdin `/probe-nope`: frames `system/init`, `user`, `assistant`, `result/success`; exit 0; stderr empty; no error frame. The model answered "`/probe-nope` isn't a recognized command in this workspace/session...". |
| **T5** prose | **TESTED: model choice, via the read tool.** | Turn 5, stdin `Use the probe-gamma skill.`: `assistant` "Using `<plugin-skill-a>` ... then I'll invoke `probe-gamma`", then `tool_call/started` + `completed` with `readToolCall {path: "<scratch>/.cursor/skills/probe-gamma/SKILL.md"}`, then `assistant` = `GAMMA-20e5daa8`. There is no skill tool; it is a file read. |
| **T6** reference file | **TESTED: readable, by a tool call, after a wrong first path.** | Turn 10, `--resume` of turn 1's session, stdin `Now give me the extra token of the probe-alpha skill.`: `readToolCall {path: "<scratch>/references/extra.md"}` failed with `File not found`; `globToolCall **/references/extra.md`; `readToolCall <scratch>/.cursor/skills/probe-alpha/references/extra.md` succeeded; `assistant` = `BETA-989bff02`. Ran under Squawk's `--force --trust`, no approval frame. Other permission settings: NOT TESTED. |
| **T7** second turn / resume | **TESTED: works.** | Turn 9, `--resume <session_id of turn 1>`, stdin `/probe-gamma second turn`: init frame has the same `session_id`; `assistant` = `GAMMA-20e5daa8:second turn`, no `tool_call`. For Squawk a second turn and a Continue are the same thing: a new process with `--resume`. |
| **T8** skill added after start | **TESTED: a later turn sees it.** | `.cursor/skills/probe-late` created after turn 10, not committed. Turn 11, `--resume` of the same session, stdin `/probe-late`: `assistant` = `LATE-cbcb2463`, no `tool_call`. A new ACP session also listed `probe-late`. Inside one long-lived ACP session: NOT TESTED. |

### Source-only claims from the first report, now checked

| Claim | Result |
| --- | --- |
| The trigger id is the folder name, not the frontmatter `name` | **Confirmed (TESTED).** Turn 6, stdin `/probe-one`: `assistant` = `FOLDERONE-5830ce8c` (folder `probe-one`, `name: probe-two`), no `tool_call`. ACP lists `probe-one` with that folder's description. |
| `/name` matches anywhere in the stdin text after whitespace | **Confirmed (TESTED).** Turns 2 (after `\n\n---\n\n`), 3 (mid-sentence), 8 (four names on one line, all four attached). |
| A `/name` inside Squawk's prepended system prompt text also matches | **Confirmed (TESTED).** Turn 7, stdin `...Helper notes are kept at /probe-gamma for reference.\n\n---\n\nDo not use any tools. If the full instructions of a skill were attached to this message, follow them. Otherwise reply with exactly NONE.`: `assistant` = `GAMMA-20e5daa8`, no `tool_call`. |
| Unknown names pass as plain text | **Confirmed (TESTED)**, T4. |
| Project folders read: `.cursor/skills`, `.agents/skills`, `.claude/skills`, `.codex/skills`, `.grok/skills` | **Confirmed (TESTED).** Turn 8, stdin `/probe-claude-dir /probe-agents-dir /probe-codex-dir /probe-grok-dir` + "list every token whose full instruction text you can see, no tools": `assistant` = `DIRCLAUDE-32d8ed31 DIRAGENTS-7c6434b1 DIRCODEX-c2402d14 DIRGROK-daa3aff4`, no `tool_call`. `.cursor/skills` in every other turn. ACP lists all of them as `(project skill)`. |
| The same folder name in two roots gets a `-2` suffix | **Wrong; corrected (TESTED).** The later root replaces the earlier one. With `probe-alpha` in both `.cursor/skills` and `.agents/skills`, turn 12 (`/probe-alpha` + "list every attached token") returned only `ALPHADUP-fa25ca2d` (the `.agents` copy), and ACP lists one `probe-alpha` with the `.agents` description. DOCS: root order is builtin, then per workspace `.cursor`, `.claude`, `.codex`, `.grok`, `.agents`, then the user roots, each overwriting the same id; so a user-level skill with the same folder name would replace the project one (user-over-project: NOT TESTED). The suffix applies only inside one root. |
| The print init frame has no skill list | **Confirmed (TESTED)**, L1. |
| ACP list leaves out plugin skills | **Confirmed (TESTED)**, L1. |
| Print loads skills at each process start | **Confirmed (TESTED)**, T8. |

### Name rules (DOCS unless marked)

- Id = folder name (TESTED). Slash charset `[a-zA-Z0-9_-]`; an id with other characters cannot be referenced.
- `user-invocable: false`, or `metadata.surfaces` without `cli`, hides a skill from the slash list. Files over 1 MB are skipped.
- TESTED (ACP list): `~/.claude/skills/<user-skill>` and `~/.agents/skills/<user-skill>` are not listed. Their
  `SKILL.md` is a symlink to a file outside the skills folder; the loader requires the real path to stay inside the root.
- Plugin-qualified names (`plugin:skill`): NOT TESTED. The slash regex has no `:`. Whether `/<plugin-skill-a>`
  attaches a plugin skill in print: NOT TESTED (turn budget).

## Surprises

- The trigger scans the whole stdin text, so any ` /word` in Squawk's system prompt or in pasted user text
  that equals a skill folder name attaches that skill (turn 7).
- No error for an unknown name, so a mistyped skill is silent (T4).
- A duplicate folder name is resolved by root order, not by an error or a suffix: `.agents/skills` beat `.cursor/skills` (turn 12).
- ACP's list and print's skill set differ: the print model knew the plugin skill `<plugin-skill-a>`, ACP did not list it.
- With the skill attached, the model still looked for `references/extra.md` in the repo root first (T6).
- Every print run left `worker-server`, `npm exec typescript-language-server` and its `node` child with cwd =
  the scratch repo; stopped by PID after each of the 12 runs.
- `agent login` (or the first run after it) replaced the CLI build; Squawk passes `--disable-auto-update`, the login did not.

## Not tested, and why

- `$probe-alpha`, `/skill:probe-alpha`, a plugin skill by `/name`, plugin-qualified names: 12-turn budget spent.
- A user-level skill overriding a project skill of the same name: needs a write to a user home, which the brief forbids.
- `CURSOR_CONFIG_DIR` effect on the list: the brief limits L2 to cwd.
- T6 under other permission settings: Squawk only launches with `--force --trust`.
- T8 inside one long-lived ACP session, and the trigger through ACP `session/prompt`: ACP is not Squawk's transport.
- Results come from one model (`gpt-5.4-nano-low`). The attach step is client-side and model-independent;
  whether a stronger model always obeys an attached skill was not compared.

## History: first run blocked by auth

On the first run (CLI 2026.10.22, about 12:15 to 12:28) `--list-models`, print and ACP `session/new` all
answered "Authentication required" within 0.6 s, while `agent status` printed "Login successful". The owner
logged in again at 12:43; nothing in this probe changed auth.

## Cleanup

Both scratch folders under `/tmp` are removed. No process with cwd in them remains (scanned `/proc/*/cwd`).
Started and ended: 12 print runs (each exited 0), 3 `agent acp` runs (each stopped by PID, exit 143), and
their leftovers stopped by PID. The CLI wrote its own session files under `~/.cursor`; nothing there was
edited by hand.

## ACP for discovery only (follow-up)

CLI `2026.11.13-eacade1`, 2026-11-16 13:04 to 13:25, new scratch repo with one project skill. ACP is **not**
Squawk's transport. Model turns: 3 (`gpt-5.4-nano-low`), all in print mode with Squawk's flags. Load average 21 to 37.

ACP list call = `agent --disable-auto-update acp`, cwd = scratch; `initialize`, `authenticate {methodId:"cursor_login"}`,
`session/new {cwd, mcpServers: []}`, wait for `available_commands_update`; no prompt sent.

### Point 1: what one ACP list call leaves behind

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Files written per call | TESTED | Snapshot of path, size, mtime over `~/.cursor`, `~/.config/cursor`, `/tmp/cursor-agent-logs-1001`, `/tmp/cursor-agent-persist-1001`, `~/.cache/cursor-compile-cache` before and after. Every call: NEW `~/.cursor/acp-sessions/<sessionId>/meta.json` (58 bytes). First call for a cwd: NEW `~/.cursor/projects/tmp-skill-probe-cursor-<x>/{repo.json, mcp-auth.json, worker.log}`; later calls only grow `worker.log`. CHANGED on calls: `~/.cursor/statsig-cache.json`, `~/.cursor/skills-cursor/.sync-manifest.json`, and on the first call `~/.cursor/cli-config.json`. `~/.config/cursor`: unchanged (1 file). New `/tmp/cursor-agent-logs-1001/session-*.log` files appeared every 10 to 20 s; the two sampled do not name the scratch path, so they are not attributed to this probe. |
| Chat records | TESTED: none | `~/.cursor/chats` stayed at 246 files across all three calls. For contrast, each print turn added `~/.cursor/chats/<hash>/<id>/{store.db, meta.json}` and `projects/<slug>/agent-transcripts/<id>/`. |
| Shows in a resume list | TESTED: no | ACP `session/list {cwd: scratch}` after the three calls: `{"sessions": []}`. `agent ls` needs a TTY (without one: "Raw mode is not supported"); in a pty its "All chats" picker showed 97 chats, newest "Today 12:51 PM", which is before the first ACP call (13:04). |
| Processes left after the leader stops | TESTED: 4 processes, about 300 s | Leader stopped by SIGTERM to its PID only (exit 143 after 55 ms). Left with `/proc/<pid>/cwd` = scratch: `node .../index.js worker-server`, `npm exec typescript-language-server --stdio`, `sh -c typescript-language-server`, `node .../typescript-language-server --stdio`; the worker and the language server keep the leader's process group. Untouched, all 4 were present at t+17 s and gone at t+299 s after the leader stopped. So `session/new` starts the same worker that print starts. |
| Signalling the leader's process group leaves nothing | TESTED | The earlier ACP runs in this report sent SIGTERM to the group (`kill -<pid>`, leader spawned as group leader); the scan right after found no process with cwd in the scratch repo. This is what Squawk's `signalExitedSession` does for print. |
| Clean shutdown leaves less | TESTED: no | No shutdown method exists (DOCS: handled methods are `initialize, authenticate, session/new, session/load, session/resume, session/fork, session/list, session/prompt, session/cancel, session/set_mode, session/set_model, session/set_config_option`). Closing stdin alone: the leader was still alive 30 s later and had to be SIGTERMed; 4 processes left. `session/cancel` notification, then closing stdin: leader exit code 0 after 767 ms; the worker processes were still there. One run each. |
| An ACP process without `session/new` starts no worker | TESTED | `initialize`, `authenticate`, `session/list`: no process with cwd in the scratch repo afterwards, and no notification received. |
| Usage | NOT TESTED for billing | TESTED: during the call the leader held 2 to 7 TCP connections to the host's HTTPS proxy, so it does talk to the network. DOCS: `session/new` loads the model list and calls `getMe`, `getTeamCommands`, `getGlobalCommands` on the dashboard client (the 6 `(global)` entries come from the server); no prompt, so no inference request is in that path. Whether Cursor counts any of it: not visible without account data. |
| Repeatability, timing | TESTED | Three calls, same cwd. List arrived 5519, 5499, 6077 ms after process start; `session/new` sent at 2343, 2840, 2897 ms and answered at 4930, 4796, 5409 ms; 32 entries each time. |
| Leftovers accumulate | TESTED: session records yes, workers no | Three calls left three `acp-sessions/<id>/meta.json`, one `projects/<slug>` folder. Call 3 ran while call 2's worker was alive and reused it (same 4 PIDs, no second set). Call 1's worker had already ended. |
| List without `session/new` | DOCS + TESTED: no | DOCS: `sendAvailableCommands` has two call sites, after `newSession` and after `loadSession`; `session/load` needs an existing session id and replays its history. TESTED: the `initialize` result has only `protocolVersion, agentCapabilities, authMethods`; `session/list` sends no notification. |

### Point 2: plugin skills in print mode

| Claim | Verdict | Evidence |
| --- | --- | --- |
| A plugin skill triggers by bare `/name` | **TESTED: yes, attached by the CLI** | Skill `<plugin-skill-b>` from `~/.cursor/plugins/cache/<marketplace>/<plugin>/<sha>/skills/`. Stdin `/<plugin-skill-b>\nUse no tools and do not follow the skill. If the full text of a skill is attached to this message, quote verbatim its line that starts with "**Core principle:**". If no skill text is attached, reply with exactly NONE.` Frames: `system/init`, `user`, `assistant` = `**Core principle:** ALWAYS find root cause before attempting fixes. Symptom fixes are failure.` (the file's line, verbatim), `result/success`. Zero `tool_call` frames. |
| Why not `<plugin-skill-a>` | TESTED (files) | That plugin has a `sessionStart` hook (`hooks/hooks-cursor.json`, key `sessionStart`), which would put that skill's text in context without any slash. A sibling skill avoids the confound. |
| The plugin-qualified form triggers | **TESTED: no** | Same prompt with `/<plugin>:<skill-b>`: `assistant` = `NONE`, zero `tool_call` frames. This is also the control that the model cannot produce the line unaided. DOCS: the slash regex `[a-zA-Z0-9_-]+` stops at `:`, so the lookup is for `<plugin>`. |
| How plugin skills enter the print slash table | DOCS (`8869.index.js`, `loadPluginSkills`; `index.js`, `cursor-plugins/dist/component-discovery.js`) | Print calls `loadCommands(workspaceDirs, {includeSkills: true, pluginsService})`. For each enabled plugin and each of its skills: id = the skill's `name`, trimmed, lowercased, whitespace to `-`, every character outside `[a-z0-9.-]` removed. So the id is the bare skill name, not the folder and not plugin-qualified. Plugin skills are added before the folder roots, so a project or user skill folder with the same id replaces the plugin's (order read from source; NOT TESTED). |
| Why ACP leaves them out | DOCS (`178.index.js`, `loadCommandsAndSkills`) | ACP calls `loadCommands(projectRoot, {includeSkills: true})` with no `pluginsService`; `loadPluginSkills` runs only when that option is present. A different call, not a filter. |
| Print model's own list versus ACP | TESTED, one turn, names only | Stdin "Use no tools. List every skill that is available to you in this session ... one per line". 75 distinct names, zero `tool_call` frames. The paths it gave were partly invented, so only names are used. Versus the ACP list for the same cwd (32 entries): 20 in both (the project skill, 6 user skills, 13 builtin). **ACP only: 12** = `copy-request-id`, 6 `(global)` commands, and 5 builtin skills (`create-subagent goal migrate-to-skills rename-chat shell`) whose frontmatter has `disable-model-invocation: true`; they are slash-only. **Model only: 55** = 52 plugin skills, `<user-skill>` (the user skill whose `SKILL.md` is a symlink out of the folder), and `review-bugbot`, `review-security`. The last two were first written to `~/.cursor/skills-cursor` after the ACP calls (CLI builtin sync, seen as NEW in the store diff), so that difference is timing, not a filter. |

Read together: ACP under-reports what print can trigger (no plugin skills, no symlinked `SKILL.md`) and lists
entries that are not skills in folders (server-side `(global)` commands, `copy-request-id`). Whether a
`(global)` command or a `disable-model-invocation` skill triggers by `/name` in print: NOT TESTED.

### Cleanup (follow-up)

Scratch folders removed. All processes with cwd in the scratch repo were stopped by PID after each run; a final
scan found none. Started: 4 `agent acp` runs, 2 `agent ls` attempts (ended by timeout), 3 print turns. One
unrelated chat store under another workspace hash disappeared from `~/.cursor/chats` during the print turns;
nothing under the user homes was edited or deleted by hand.

## Open checks, round 2 (2026-11-16)

CLI `2026.11.13-eacade1`, print mode with Squawk's flags (`agent --disable-auto-update -p --force --trust
--output-format stream-json --model gpt-5.4-nano-low`, prompt on stdin, cwd = scratch repo). Load average 55 to 70.
Model turns: 4 reached a model (2 for Check B, 2 for Check A). Two more attempts ended before any model output
(a flag the server refused, and a TLS error under the scratch config dir); both are reported below.

### Check A: does the skill set follow a non-default account home?

Print mode has no list route, so this answers it for the trigger set, with the ACP list (not Squawk's transport) as
the no-model check.

| Claim | Verdict | Evidence |
| --- | --- | --- |
| Squawk has no home variable for Cursor | DOCS (Squawk source) | `packages/cezar/src/core/agent-profiles.ts`: `ACCOUNT_LAYOUT.cursor = { select: null, ... }` with the comment "CURSOR_CONFIG_DIR relocates configuration, not a verified whole account home"; so `PROFILE_ENV_VAR.cursor` is `null`, named accounts are refused for Cursor, and `PROFILE_DIR_MARKERS.cursor = []`. No flag either: `cursor-print-runner.ts` adds no account argument. |
| What an "account" is for Cursor under Squawk | DOCS (Squawk source) | The host login, or `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` in Squawk's own environment (`provider-auth.ts`, `parseCursorStatus`); `buildChildEnv` passes every `CURSOR_*` variable to the child. `CURSOR_CONFIG_DIR` is read only by `paths.ts` (`agentHomePaths().cursor`) to find `cli-config.json` for the Settings page (`agent-config/catalog.ts`), and reaches the CLI only when it is already set in Squawk's environment. Squawk writes nothing into a Cursor home on its own. |
| Which paths follow `CURSOR_CONFIG_DIR` in the CLI | DOCS (bundle `index.js`, `cursor-config/dist/paths.js`) + TESTED | Source: the config dir is `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`, and it holds `cli-config.json`. The login file is `($XDG_CONFIG_HOME or ~/.config)/cursor/auth.json` and ignores the variable. `projects/` uses `CURSOR_DATA_DIR`, else `~/.cursor`. Skill roots and `~/.claude/plugins/installed_plugins.json` are joined to `os.homedir()`. TESTED: after the runs below the scratch home held `cli-config.json`, `statsig-cache.json`, `acp-sessions/<id>/meta.json`, `chats/<hash>/<id>/{meta.json, store.db}`; transcripts still went to `~/.cursor/projects/<slug>/agent-transcripts/`. |
| The list does not follow the variable | TESTED, no model call | Scratch home with `<scratch-home>/skills/probe-cfgdir-user/SKILL.md` and `<scratch-home>/.cursor/skills/probe-cfgdir-nested/SKILL.md`, no credential file. `CURSOR_CONFIG_DIR=<scratch-home> agent --disable-auto-update acp`, then `initialize`, `authenticate`, `session/new {cwd, mcpServers: []}`: 36 entries = 1 + 6 global + 18 builtin + 5 project + 6 user skills. The same call without the variable: the same 36 names (equal hash of the sorted name list). No entry contains `cfgdir`. |
| Login works without a login in that home | TESTED | `authenticate` answered ok at 3352 ms and `session/new` at 6429 ms under the scratch home, which holds no auth file. The login is not in the config dir. |
| The trigger set does not follow the variable | TESTED, 1 turn | Print turn with `CURSOR_CONFIG_DIR=<scratch-home>`, stdin `/probe-cfgdir-user /probe-cfgdir-nested /<one real-home user skill> /<one real-home plugin skill> /probe-unref /home` + "list every reply token ... quote the `**Core principle:**` line ... first heading of every other attached skill". `assistant`: line 1 `UNREF-1ea4c328 HOMEDIR-1674a885` (the two project skills), line 2 the plugin skill's line verbatim, line 3 the user skill's first heading plus the two project headings. Neither `CFGuser-9b8c87a9` nor `CFGnested-51d971f5` came back. Zero `tool_call` frames. |
| Real-home sources that still load under the variable | TESTED | All of them: the 6 listed user skills (from `~/.claude/skills`, 8 folders, and `~/.agents/skills`, 6 folders; `~/.cursor/skills` and `~/.codex/skills` hold none), the 18 builtin skills in `~/.cursor/skills-cursor`, and plugin skills from `~/.cursor/plugins/cache` (3 marketplaces, 11 plugin folders, 53 `SKILL.md` files). Claude's registry there lists 4 plugins. |
| A model turn under a fresh config dir | TESTED: failed on this host until one setting was set | First attempt: frames `system/init`, `user`, then `connection/reconnecting` and `retry/starting` three times; exit 1; stderr `RetriableError: [internal] ...SSL routines:ssl3_read_bytes:tlsv1 alert no application protocol`. The fresh `cli-config.json` has the key `network.useHttp1ForAgent`, as the real one does (values not read). After I set it to `true` in the scratch file the turn ran. So this host's proxy needs a setting that lives in the config dir. |
| An earlier form of the question gave `NONE` | TESTED, inconclusive | The same slash line with "list the frontmatter name of every attached skill" returned `NONE`; the token question right after it showed four skills attached. The question was the fault, not the attach. |
| `XDG_CONFIG_HOME` or `HOME` as the account switch | NOT TESTED | Source says `XDG_CONFIG_HOME` moves both the config dir and the login file, and `HOME` moves every skill root. Squawk sets neither for Cursor. |

### Check B: accidental triggers from Squawk's own prompt text

**1. The match rule (DOCS: bundle `8869.index.js`, `findSkillReferences`; examples run through that regex in Node).**

- Skills: `/(?:^|\s)\/([a-zA-Z0-9_-]+)/g` over the whole stdin text, then an exact, case-sensitive lookup of the id.
  Commands: `/(?:^|\s)\/([a-zA-Z0-9_-]+)(?:[ \t]+([^\n]+))?/g`, the rest of the line becomes arguments.
- Before the `/`: start of the whole text, or any whitespace (space, tab, newline, no-break space). No `m` flag.
  Anything else before it blocks the match.
- After the id: nothing is required. The id is the longest run of `[a-zA-Z0-9_-]`, whatever follows.

| Text | Ids matched |
| --- | --- |
| `/name`, `x /name`, `x\n/name`, `- /name`, `1. /name`, `> /name` | `name` |
| `see /name.`, `see /name, ok`, `see /name) ok`, ` /name:sub`, ` /name/SKILL.md` | `name` |
| ` /home/user/x` | `home` |
| `` `/name` ``, `"/name"`, `'/name'`, `(/name)`, `</name>` | none |
| `https://x/name`, `a/name`, `~/name`, ` //name`, ` /.cursor/skills` | none |

**2. A sample of what Squawk sends (built by calling Squawk's own builders from this worktree; stub store, no secrets).**

`cursor-print-runner.ts` sends `prependSystemPrompt(systemPrompt, userPrompt)` = `systemPrompt + "\n\n---\n\n" + userPrompt`.
The system prompt is `composeSystemPrompt(skill part, launchSystemTail(...))`; the opening user prompt is the
session-context prefix (the injected handoff file) plus the task text.

| Part (builder) | Chars | Matches | Ids |
| --- | --- | --- | --- |
| System tail: delegation with workers on (`provisionDelegationSession`), automations, webhooks, artifacts, long commands, handoff contract | 33,384 | 0 | none: every absolute path in it is single-quoted by `shellQuote`, and other slashes sit inside words |
| Skill part (`skillSystemPrompt`, present when a skill is selected) | 514 | 2 | the selected skill's name, from `Selected skill: /<name>`; the first path segment of `Skill files are installed on disk at: <dir>` |
| Context prefix (`buildSessionContext` with a file from `seedHandoffFile` + `renderHandoffRecords`) | 674 | 2 | the first path segment of `**Worktree:** <path>`; `cezar`, from the records end marker `<!-- /cezar:records -->` (present once an autosave record exists) |
| **Whole stdin** | 34,787 | **4** | 4 distinct: `probe-sel` (the selected skill), `tmp` (skill folder under `/tmp` here), `home` (worktree path), `cezar` |

Two more Squawk-authored texts match the rule by source reading, not in the sample: the lifecycle input
`Skills installed for /<name>: ...` / `Skill files for /<name> are at <dir>.` (`workflows/run/run-skills.ts`), and the
pasted-attachment list `- <absolute path>` (`workflows/pasted-content.ts`). So the candidate ids from Squawk's own
words are: the selected skill's name, `cezar`, and the first segment of an absolute path (`home`, `Users`, `tmp`, `var`, ...).
Text Squawk forwards but does not write (skill body, extra system prompt, handoff goal and progress, user text) can match anything.

**3. Real turn (TESTED).** Scratch repo with `.cursor/skills/{home, tmp, cezar, probe-sel, probe-unref}`, each with its own
token. The Squawk-injected body of `probe-sel` carried a different token, `INJECTED-4cc1033c`. Stdin = the 34,787-char
sample + "Use no tools and do not follow any skill. List every reply token ... in skill instruction text you can see
in this message or attached to it".

- Frames: `system/init`, `user`, `assistant`, `result/success`; zero `tool_call` frames.
- `assistant` = `NATIVESEL-c26703ba TMPDIR-9cc61ad6 HOMEDIR-1674a885 CEZARWORD-4e040800 INJECTED-4cc1033c`.
- All four candidate skills were attached. `probe-unref`, which the text never names, was not (`UNREF-1ea4c328` absent).
- So a skill Squawk injects today is delivered twice when a native folder of the same name exists: once as Squawk's
  text and once as Cursor's attachment of the native copy.
- On this host none of the 31 non-project entries in the ACP list is named `home`, `tmp`, `cezar`, `Users`, `var`,
  `private`, `usr`, `opt` or `mnt`; the path-segment and `cezar` hits need a skill or command folder with that name.

**4. Escapes.**

| Escape | Verdict | Evidence |
| --- | --- | --- |
| Put a non-whitespace character before the `/` | TESTED: works | The same sample with four edits (`` `/probe-sel` ``, both paths in single quotes, `<!--/cezar:records-->`): the regex finds 0 matches, and the turn returned only `INJECTED-4cc1033c`, zero `tool_call` frames. |
| A prompt marker or escape syntax that stops the scan for part of the text | DOCS: none | The resolver is the bare regex above over the whole string: no backslash handling, no code-fence or tag awareness, no offset or range argument. |
| `--exclude-workspace-context` (hidden flag: "Strip all workspace-sourced context (rules, skills, transcripts, notes) from the session") | TESTED: refused for this account | DOCS: with it print skips the loader, so no skill or command is attached at all; it is whole-session, not per part. Turn with the flag: exit 1 after three retries, stderr `RetriableError: [invalid_argument] Workspace context exclusion is not allowed for this user, team, or selected model`. No model output. |
| `--system-prompt <file>` (hidden flag: "Replace system prompt with contents of file (Anysphere/OpenAI team only)") | DOCS only, NOT TESTED | The scan covers the stdin prompt only, so text passed this way would not be scanned; the help text limits it to Cursor's own team and it replaces Cursor's system prompt. |

### Cleanup (round 2)

Scratch repo, scratch home and tools folder under `/tmp` are removed. Each print run was a session leader; its
process group got SIGTERM after exit and a scan of `/proc/*/cwd` found nothing left in the scratch folders after any
run. The 2 ACP runs were stopped by their process group. Nothing under `~` was edited by hand; the CLI wrote its own
session files under `~/.cursor/projects/<scratch slug>/`.
