# The Antigravity ACP wire (registry server 1.5.0, CLI 1.5.14)

This note records what Google's Antigravity ACP server does on its wire, measured live on
2026-11-21 for hearsay-tools/squawk#4000. The Antigravity runner (hearsay-tools/squawk#4004)
reads its facts from here. The recorded frames are in
[`packages/cezar/src/runners/antigravity/__fixtures__/`](../../packages/cezar/src/runners/antigravity/__fixtures__/).

Two builds are recorded. [The Antigravity CLI](#the-antigravity-cli-antigravity-acp-1514)
(`antigravity acp`, 1.5.14, hearsay-tools/squawk#4058) is the build the runner moves to in
hearsay-tools/squawk#4060. Its section lists every difference from the registry server. All
sections after it record the registry server `agy_acp_server.par` 1.5.0.

In short: agy speaks ACP protocol version 1 over stdio. It mints its own session ids, steers a
second prompt into the running turn, asks native questions through `session/request_permission`,
holds a turn open while subagents, background commands and timers run, and reports tokens per
turn with no cost. The system prompt does not survive `session/resume`.

## The Antigravity CLI (`antigravity acp` 1.5.14)

Measured live on Linux x86-64 on 2026-11-22. A fresh `HOME`, `TMPDIR` and `--gemini-dir` per
probe, `GEMINI_API_KEY` sign-in, the same JSON-RPC driver with a reader thread, and a local
streamable-HTTP MCP server. The CLI fixtures are the `cli-*.ndjson` files.

In short: the CLI is one Go binary with an `acp` subcommand. It keeps the 1.5.0 handshake and
most frame shapes, but several turn rules changed. Background commands and `schedule` timers
no longer hold the turn: they wake the idle session later, and the agent then streams text,
runs tools and asks for permission with no prompt open. A steered prompt ends the running
prompt at once and carries the turn itself. `ask_question` ends the turn with the question as
text; the next prompt is the answer. The system prompt is saved with the session.

### Build, files and launch

| Item | Value |
| --- | --- |
| Manifest | `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/<target>.json`, targets `linux_amd64`, `linux_arm64`, `darwin_amd64`, `darwin_arm64`, `windows_amd64`. Each gives `version`, `url` and `sha512`. On 2026-11-22 every target named 1.5.14. |
| Archive | `storage.googleapis.com/antigravity-public/antigravity-cli/1.5.14-5302690847260672/<dir>/<file>`. The sha512 matched for the three archives downloaded. |
| Files | One executable named `antigravity`. No `.par`, no `localharness_external`, no other file. The language server runs inside the same process (its log says "Starting language server process with pid" with the ACP process's own pid). |
| Command | `antigravity acp --gemini-dir <absolute profile folder> --app-data-dir antigravity-acp` (t3code's launch). `--uid=` is refused: `Error: flags provided but not defined: -uid`, exit 1. `--debug` and `--notices` are gone. |
| Symlink | A bare `agy` symlink to the binary in another folder passes `session/new`. The 1.5.0 harness lookup (`ANTIGRAVITY_HARNESS_PATH`, owner decision D1) no longer applies. |
| `acp` flags | `--gemini-dir`, `--app-data-dir` (default `antigravity-cli`), `--add-dir`, `--agent`, `--dangerously-skip-permissions`, `--disable-telemetry`, `--include-default-customizations` (default true), `--log-file`, `--login`, `--process-per-session`, `--sandbox`, `--stdio` (default), `--ide-mcp-port`, and internal ones (`--worker`, `--cloud_code_endpoint`, `--use_stubby_auth`). Most also have a snake_case spelling. |

| Platform | Archive | Executable | `--version` stdout |
| --- | --- | --- | --- |
| Linux x86-64 | `linux-x64/cli_linux_x64.tar.gz`, 101 MB | `antigravity`, ELF, 273 MB | `1.5.14`, measured |
| Linux arm64 | `linux-arm/cli_linux_arm64.tar.gz` | not downloaded | not measured |
| macOS arm64 | `darwin-arm/cli_mac_arm64.tar.gz`, 86 MB | `antigravity`, Mach-O arm64, 229 MB, signed "Developer ID Application: Google LLC (EQHXZ8M8AV)" | not run; the binary holds the same `1.5.14` and `acp` help strings |
| macOS x86-64 | `darwin-x64/cli_mac_x64.tar.gz`, 92 MB | `antigravity`, Mach-O x86-64, 239 MB, same signature | not run; same strings |
| Windows x86-64 | `windows-x64/cli_windows_x64.exe`, a bare executable | t3code installs it as `agy.exe` | not measured |

**Detection.** `antigravity --version` prints one line, the bare version (`1.5.14`), and
nothing on stderr. It has no `Build label:` line and no `antigravity_extensions/acp_server`
text, so today's `ANTIGRAVITY_DETECTION.banner`, `versionPattern` and
`antigravityBuildLabel` do not match it. A bare version line is a weak banner. The
`--help` text identifies the CLI: its first line is `Usage of antigravity:` and it lists
`acp  Start the Agent Client Protocol (ACP) stdio server`. `antigravity acp --help` starts
with `Usage: antigravity acp [flags]`. Both were measured on Linux; the macOS binaries hold
the same strings.

**Cost.** `--version`: 0.18–0.30 s wall, about 175 MB peak RSS, nothing written. `initialize`
answers 0.14–0.25 s after spawn; RSS is about 176 MB then, 220 MB after `session/new` and
about 240 MB while a command runs. `session/new` answers in 0.02–0.04 s. The first
`session/new` writes about 800 KB of built-in skills and plugins under the app data folder.
No launch unpacked anything into `TMPDIR` or `HOME` on Linux; the t3code note of about 1 GB
per launch did not show here. The host load average was 23–28.

### Folders and stored state

- `--gemini-dir` defaults to `.gemini`. A relative value resolves under `HOME`, not the cwd.
  `GEMINI_HOME` is ignored: a launch with no flags and `GEMINI_HOME` set wrote to
  `$HOME/.gemini/antigravity-cli/`.
- `--app-data-dir` must be relative and is joined under the gemini folder. An absolute value
  fails `session/new` with -32603 "Failed to start Antigravity: language server failed to
  start: must not be absolute: …", after it created the joined path under the gemini folder.
- `<gemini-dir>/<app-data-dir>/` holds the conversations (`conversations/<sessionId>.db`), the
  per-conversation `brain/<sessionId>/` (transcripts, step outputs, artifacts), the glog files
  (`log/acp-server-<time>-<pid>.log`; on 1.5.0 they went to `TMPDIR`),
  `cache/acp-auth-state.json` (`{"methodId": …}`, no secret), MCP tool descriptors
  (`mcp/<server>/<tool>.json`), `builtin/`, `installation_id`, `conversation_summaries.db` and
  `jetski_state.pbtxt`.
- `<gemini-dir>/config/` holds `config.json` (plugin enablement), `mcp_config.json`, `projects/`
  and a `.migrated` marker.
- The API key is stored nowhere. No probe wrote a file under `HOME` or `TMPDIR`. The log names
  `$HOME/.config/antigravity/plugin-secrets.json` as the plugin secret file store; it was not
  created.
- The binary holds no `GEMINI_HOME`, `AGY_ACP_FORCE_FILE_STORAGE` or
  `AGY_ACP_DEFAULT_MODEL` string; `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` remain.

### CLI sign-in

| Case | CLI 1.5.14 | Registry server 1.5.0 |
| --- | --- | --- |
| `authenticate gemini-api-key` with a key | `{}` in 0.07 s (`cli-handshake.ndjson`). Writes `cache/acp-auth-state.json`; the key comes from `GEMINI_API_KEY` or `_meta.apiKey`. | `{}`; wrote `{"auth":{"type":"gemini-api-key"}}` to `antigravity-acp/settings.json` |
| The same with no key | -32602 "GEMINI_API_KEY is not set; pass an API key in _meta.apiKey or set the GEMINI_API_KEY environment variable." (`cli-auth-no-key.ndjson`) | `{}`, then `session/new` failed |
| `session/new` before sign-in | -32000 "Authentication required" (`cli-auth-no-key.ndjson`) | an auth error (not run) |
| `authenticate oauth-personal` with no display | -32603 "No browser is available here (no graphical display is available to open a browser). Run \`agy acp --login\` in a terminal on this machine, then retry; or use a Gemini API key." (`cli-oauth-headless.ndjson`) | a loopback listener on 127.0.0.1 and `$BROWSER` |
| `antigravity acp --login` | Prints a Google consent URL with `redirect_uri=https://antigravity.google/oauth-callback`, then "Then paste the authorization code, or the full URL of the page you land on, and press Enter:". With empty stdin it prints "login cancelled: no authorization code was entered" and exits 1. | no such flag |

Where a Google sign-in is stored was not measured: no Google account was used. The binary
holds a Secret Service keyring with a file fallback ("Using file-based token storage because a
keyring timeout was recorded within …"). t3code reports that 1.5 ignores
`AGY_ACP_FORCE_FILE_STORAGE` and keeps one keyring entry for every profile unless
`SSH_CONNECTION` is set.

### Handshake and session

- **`initialize`** (`cli-handshake.ndjson`): `agentInfo {name: "Antigravity ACP Server",
  version: "1.5.14"}`, no `title` (1.5.0: `antigravity-acp`, title "Google Antigravity").
  `promptCapabilities.audio` is `false`. `mcpCapabilities` is absent, yet HTTP MCP servers work.
  `sessionCapabilities` adds `close` and `load`. The result repeats `loadSession` and
  `sessionCapabilities` in snake_case (`load_session`, `session_capabilities`). The four
  `authMethods` keep their ids.
- **`session/new`**: no `usage_update` or `available_commands_update` before the response; both
  come with the first prompt. Modes are `default`, `accept-edits` and `plan`; `auto_edit` and
  `yolo` are gone, and `session/set_mode yolo` returns -32602 "Unknown mode: yolo"
  (`cli-modes.ndjson`). `configOptions` are `model`, `thought_level` (1.5.0: `thinking_level`)
  and `mode`. `models.currentModelId` is `gemini-3.1-pro-low` (the `model` option
  `gemini-3.1-pro`, thinking `low`). The table offers `gemini-4-neon`, `-carbon`, `-hydrogen`
  and `-argon`, `gemini-3.8-flash`, `3.7-flash` and `3.6-flash`, and `gemini-3.1-pro`; 1.5.0
  also offered `3.5-flash` and no `gemini-4` model.
- **Options** (`cli-config-options.ndjson`): `session/set_config_option` and `session/set_model`
  refuse an id outside the table with -32602 "Unknown model ID: …". A change also sends a
  `config_option_update` notification.
- **Titles**: `session_info_update {title}` arrives after the first model step.
- **Available commands**: `goal`, `compact`, `schedule`, `browser`, `plan`, `grill-me`,
  `learn`, then every skill by name (see [Skills](#cli-skills)). `logout` and `usage` are gone.
- **List** (`cli-session-list.ndjson`): each entry adds `updatedAt`.
- **Load** (`cli-load-replay.ndjson`): replays the history before its response, as on 1.5.0.

### CLI models and the API host

`GOOGLE_GEMINI_BASE_URL` is still honored. `AGY_ACP_DEFAULT_MODEL` is ignored, and an id outside
the table cannot be set, so CLI Proxy refuses every turn with 400 `model_not_found` (the request
named `gemini-3.1-pro-preview`; titles use `gemini-3.1-flash-lite-preview`). All CLI live turns
went through a local shim that renamed the model in the request path to `gemini-3-flash`. The
binary also names `AGY_LLM_GATEWAY_URL`, `AGY_LLM_GATEWAY_MODELS` and `AGY_LLM_GATEWAY_API_KEY`;
they were not probed. A provider error is still message text plus `end_turn`, but the text now
starts "⚠ agent executor error:" (1.5.0: "Agent execution error:") (`cli-config-options.ndjson`).

### RunnerFacts on the CLI

| Field | 1.5.0 value | CLI 1.5.14 | Evidence |
| --- | --- | --- | --- |
| `transport` | `stdio` | same | every `cli-*` fixture |
| `sessionIdSource` | `native` | same | `session/new` returns an agent UUID (`cli-handshake.ndjson`) |
| `systemPromptOnResume` | `resent` | **changes**: the prompt is saved with the session, and a resent one is added to the saved one, not put in its place. Neither value names this exactly. Resending duplicates the prompt, which is the case `in-thread` guards against: with `in-thread`, Squawk does not resend the skill prefix on a same-session resume. A changed prompt cannot replace the saved one; hearsay-tools/squawk#4060 chooses the value. | A plain `session/resume` in a new process answered the secret word; the word was only in the `session/new` request (`cli-resume-without-system-prompt.ndjson`). A resume that sent a different prompt answered both words, "ORCA-3, ORCA-4" (`cli-resume-changed-system-prompt.ndjson`). |
| `inputDelivery.mode` | `steer` | same, with a new acknowledgement order | A second `session/prompt` during a command ends the **first** prompt with `end_turn` 4 ms later. The running work goes on, and the second prompt's response ends the turn; the answer obeyed the steer (`cli-midturn-prompt.ndjson`). 1.5.0 answered the steer early instead. |
| `inputDelivery.consumption` | `unobservable` | same | no frame echoes the steer |
| `inputDelivery.acknowledgement` | `response` | same field, other prompt: the steer's response is the end of the turn | `cli-midturn-prompt.ndjson` |
| `inputDelivery.humanInputAtTurnEnd` | `held-when-late` | not probed on the CLI | — |
| `nativePermission` | `in-turn` | **changes to `after-turn`** | A background command finished 10 s after `end_turn`; the agent then ran `echo after-bg` and sent `session/request_permission` with no prompt open (`cli-permission-after-turn.ndjson`). |
| `nativeAsk` | `answerable` | answerable, by another route | `ask_question` is a `tool_call` (title `Run ask_question`, `rawInput.questions[{question, options, is_multi_select}]`). The question comes as `agent_message_chunk` text ("- [1] (Recommended) Red"), and the prompt ends with `end_turn` while the call is `pending`. The next `session/prompt` is the answer: the call completes in that prompt (`cli-interaction-question.ndjson`). No `session/request_permission`, no `interaction_` id. |
| `nativeSubagents` | `turn-held` | observed held; not settled | `invoke_subagent` completed at once and the parent polled with `manage_subagents`, `send_message` and reads of the child's transcript until it ended its turn (`cli-subagent.ndjson`). Children are separate conversations (`brain/<child id>/`). Since commands and timers no longer hold the turn, a parent that ends its turn while a child runs is likely; not observed. |
| `childWork` | `none` | same | child calls carry no link to `invoke_subagent` (`cli-subagent.ndjson`) |
| `hookEvents` | `none` | same | no hook frame in any CLI fixture; hooks not probed |
| `humanPromptHold` | `acknowledgement` | same | no consumption signal |
| `nativeTimerTool` | `null` | **changes to `schedule`** | `/schedule in 20 seconds: …` sent `tool_call` `Run schedule` (`rawInput {DurationSeconds, Prompt}`) and the turn ended. 20 s later, with no prompt open, the call completed and the agent streamed "TIMER-FIRED" (`cli-schedule-timer.ndjson`). The timer wakes an idle session. |
| `costReport` | `per-turn` | same for prompts | the `session/prompt` result carries the turn's `usage`. Work after the turn (timer, background completion) reports only `usage_update`. |
| `claudeModelAliases` | `false` | same | Gemini ids only |
| `turnStart` | `on-write` | same for prompts | Agent-started work after the turn has no start frame. |
| `skillTriggerMidTurn` | `true` | not probed on the CLI | — |
| `skillUnknownName` | `silent` | same | `/no-such-skill` gets a model reply (`cli-skills-live.ndjson`) |
| `skillsSeenBySession` | `live` | same | a skill added on disk mid-session was listed and ran with `/sk-late` (`cli-skills-live.ndjson`) |
| `shutdownDescendants` | `observed-tree` | same | A command runs as `bash -c …` in its own session (pgid = sid = its pid) and survived the ACP process exit. |

### CLI tool frames

- Every `tool_call` and `tool_call_update` now carries `name` (the native tool name) and `args`
  (the same object as `rawInput`). A call starts `in_progress`, turns `pending` with the
  permission request, then `in_progress` again (`cli-prompt-command.ndjson`).
- **Ids** are `call_<digits>` only.
- **Permission options** are `allow` (`allow_once`) and `deny` (`reject_once`) for every tool.
  `allow_always` and `_meta["agy.security.warning"]` are gone.
- **Denial** (`cli-permission-reject.ndjson`): the call closes `failed` with `rawOutput
  {output: ""}`, and the prompt ends with `end_turn` at once, with no model step after it.
- **Command**: title is the command line, kind `execute`, `rawInput {CommandLine, IsDaemon,
  WaitMsBeforeAsync, toolSummary}`. Completion has `rawOutput {output[, exit_code]}` and the same
  text as `content`.
- **Read**: `read_file`, title `File <relative path>`, kind `read`, no request. It read the file
  itself, though the client advertised `fs.readTextFile`; no `fs/read_text_file` came
  (`cli-prompt-edit.ndjson`).
- **Edit**: `edit_file`, title `File <relative path>`, kind `edit`, `rawInput {Path, Target,
  Replacement}`. Completion has a `diff` content item with no `_meta.kind` and `rawOutput {}`.
- **MCP** (`cli-mcp-two-turn.ndjson`): name `mcp_<server>_<tool>`, title `Run
  mcp_<server>_<tool>`, kind `other`, `rawInput` with an added `toolSummary`. There is no
  `_meta.mcp {server, tool}`; the server and tool are known only from the qualified name.
- **Native tools** listed by the model: `read_file`, `run_command`, `manage_task`,
  `send_message`, `schedule`, `invoke_subagent`, `define_subagent`, `manage_subagents`,
  `write_file`, `edit_file`, `search_web`, `run_workflow`, `swarm`, `ask_question`.
- **Cancel** (`cli-cancel.ndjson`): the prompt answers `stopReason: "cancelled"` 5 ms after
  `session/cancel`, before the open command closes `failed`. No "context canceled" text.
- **Background command** (`cli-background-command.ndjson`): a command past
  `WaitMsBeforeAsync` stays `in_progress` and the turn ends. When it ends, `tool_call_update
  completed` arrives, then the agent's own thoughts, text and `usage_update`, with no prompt
  open and no response frame.

### MCP

- HTTP MCP works with no `mcpCapabilities`. The MCP client sends `server/discover` first, then
  `initialize` with protocol version `2025-11-25` and client `antigravity-client`. Each
  `tools/call` carries `_meta` with the conversation's artifacts folder.
- A server named `squawk` and one named `cezar_ci_<32 hex>` both completed calls, in two
  turns of one session (`cli-mcp-two-turn.ndjson`).
- **The 64-character limit holds** (`cli-mcp-name-limit.ndjson`). The server log said
  `encountered invalid tool t65_aaaaaaaaaaaaaaa: tool name mcp_cezar_ci_<32 hex>_t65_aaaaaaaaaaaaaaa
  violates ^[a-zA-Z0-9_-]{1,64}$` for the 65-character name. The wire carries no error. The CLI
  drops that tool only: asked to call it, the model answered "MISSING" and listed `echo` and
  `t64_aaaaaaaaaaaaaa`, and no `tools/call` reached the server. The 64-character name
  (`mcp_cezar_ci_<32 hex>_t64_aaaaaaaaaaaaaa`) completed a call in the next turn. The 1.5.0 failure of the second prompt
  (`unexpected end of JSON input`) did not occur with three tools and an API key; the personal OAuth, full-tool-list case was not
  rerun. Keep the `squawk` alias.

### `_meta.antigravity`

- `systemPrompt.append` is honored on `session/new` and `session/resume`, and saved (see
  `systemPromptOnResume`).
- `disabledTools` is ignored: with `["run_workflow", "invoke_subagent"]` the model still listed
  both tools, the same list as without it.
- `eagerMcpServers` is unknown to the binary (no such string). MCP tools were callable in the
  first turn without it.
- `run_workflow` wrote no `skills/system/run-workflow/SKILL.md` into any probe workspace; the
  workspace stayed empty.

### CLI skills

`available_commands_update`, sent once with the first prompt, lists every skill by name, so the
wire now names the skills (`cli-interaction-question.ndjson`, the first prompt of the skill
session). A folder change sends no new update; a later process lists the added skill
(`cli-resume-changed-system-prompt.ndjson`). One skill per candidate folder showed which folders
the CLI reads. The commands list and the model's answer agree (`cli-skill-folders.ndjson`; the
model's thoughts quote each `SKILL.md` path):

| Folder | Read |
| --- | --- |
| `<gemini-dir>/config/skills` | yes |
| `<gemini-dir>/<app-data-dir>/skills` | yes (new) |
| `<gemini-dir>/skills` | yes (new) |
| `<cwd>/.agents/skills` | yes |
| `<cwd>/.agent/skills` | yes (new) |
| `<cwd>/.gemini/skills` | no (1.5.0: yes) |
| `<gemini-dir>/antigravity-cli/skills` with `--app-data-dir antigravity-acp` | no |
| `$HOME/.gemini/skills`, `$HOME/.gemini/config/skills`, `$HOME/.agents/skills`, `$HOME/.claude/skills`, `<cwd>/.claude/skills` | no |

Built-in skills are `agy-customizations`, `antigravity-guide`, `run-workflow`, `swarm_monitor`
and `swarm_pane`.

### Parity exemptions to revisit

- D3 (native cross-session messaging): the CLI has `send_message` and `manage_subagents`,
  between a parent and its subagents. The 1.5.0 reason ("no cross-session tool") no longer
  holds as written.
- `plan.updated with entries`: `plan` is now a mode and a command; no ACP `plan` frame was
  seen, but it was not probed.

### What today's mapper does with CLI frames

Each `cli-*.expected.json` records what the current mapper (written for 1.5.0) makes of the
frames. These are the cases hearsay-tools/squawk#4060 must change:

1. A tool that completes after the turn's response is closed twice: `item.completed failed` at
   the response, then `completed` (`cli-midturn-prompt`, `cli-permission-after-turn`,
   `cli-interaction-question`, `cli-background-command`).
2. The steered prompt's early-ended first prompt maps to a full `turn.completed`, then a second
   turn (`cli-midturn-prompt`).
3. Work after the turn (`cli-permission-after-turn`, `cli-schedule-timer`,
   `cli-background-command`) maps to items with no open turn.
4. "⚠ agent executor error:" maps to `end_turn`, not `error` (`cli-config-options`).
5. MCP items are named `mcp_<server>_<tool>`, since `_meta.mcp` is absent
   (`cli-mcp-two-turn`). The permission policy also reads `_meta.mcp`, so a trusted Squawk
   tool would not be recognized.
6. `ask_question` maps to a plain tool item, with no ask (`cli-interaction-question`).

## What was run

| Item | Value |
| --- | --- |
| Build | ACP registry archive `antigravity-acp` 1.5.0, `agy-acp-server-1.5.0-linux-x86_64.zip` (sha256 `36f373e8…808c9f`) |
| Files | `agy_acp_server.par` (714 MB, an embedded Python 3.14 program) and `localharness_external` (140 MB, a Go harness that the `.par` starts per session and talks to over a localhost websocket) |
| Command | `agy_acp_server.par`, with `--uid=` on Linux only, per the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json); macOS and Windows use no launch arguments. There is no `acp` subcommand and no `--login`, `--gemini-dir` or `--app-data-dir` flag. The program's own flags are `--debug` and `--notices` |
| Environment | `PATH`, `HOME`, `GEMINI_HOME`, `TMPDIR` (each a scratch folder), `AGY_ACP_FORCE_FILE_STORAGE=1`, `AGY_CLI_DISABLE_AUTO_UPDATE=1`, `GEMINI_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, the host's proxy and CA variables |
| Sign-in | `authenticate {methodId: "gemini-api-key"}` with the key from `GEMINI_API_KEY` |
| Model route | The owner's CLI Proxy, a Gemini API compatible endpoint, through `GOOGLE_GEMINI_BASE_URL` (see [Models and the API host](#models-and-the-api-host)) |
| Client | A small JSON-RPC driver that answers `session/request_permission` and `fs/read_text_file`, and advertises `fs.readTextFile: true`, `fs.writeTextFile: false`, `terminal: false` |
| Host | The shared development host, load average 23–27 during every measurement |

An earlier probe reported that `session/new` hangs. It does not. That probe called `select()` on
the pipe and then a buffered `readline()`. agy writes `usage_update`, `available_commands_update`
and the `session/new` response in one write, so the response stayed in Python's read buffer and
`select()` never fired again. With a reader thread, `session/new` answers in 0.11–0.2 s (0.173 s in `handshake.ndjson`).

The agent's Python sources are inside the `.par` (a zip archive). Code references below name
files under `google3/cloud/developer_experience/antigravity_extensions/acp_server/` in that
archive (`server.py` and others) and the SDK under `google3/third_party/py/google/antigravity/`.

## RunnerFacts

Each value is what agy 1.5.0 did, with the fixture or code that shows it. `RunnerFacts` is in
`packages/cezar/src/core/runner-facts.ts`.

| Field | Value | Evidence |
| --- | --- | --- |
| `transport` | `stdio` | NDJSON JSON-RPC on the stdin and stdout of `agy_acp_server.par --uid=`. Every fixture. |
| `sessionIdSource` | `native` | `session/new` takes no id and returns an agent-minted UUID (`handshake.ndjson`). `session/resume` and `session/load` need that id. |
| `systemPromptOnResume` | `resent` | `_meta.antigravity.systemPrompt.append` is not saved. After a plain `session/resume` the model answered "NONE" when asked for the secret word from its system instructions; after a resume that resent the `_meta` it answered the word (`resume-without-system-prompt.ndjson`, `resume-with-system-prompt.ndjson`; the history never held the word). `_restore_session` reads the prompt only from the request. |
| `inputDelivery.mode` | `steer` | A second `session/prompt` sent while a turn runs reaches the running turn: its text shows in that turn's answer (`midturn-prompt.ndjson`, `midturn-prompt-late.ndjson`). |
| `inputDelivery.consumption` | `unobservable` | No frame echoes the steered prompt or marks it read. |
| `inputDelivery.acknowledgement` | `response` | The steered `session/prompt` gets its own response, before the running turn ends. See [Wire hazards](#wire-hazards). |
| `inputDelivery.humanInputAtTurnEnd` | `held-when-late` | Observed: steers sent after the last tool result, and during the final answer, were read in the running turn. A prompt that arrives after the agent's step loop has ended runs as a turn of its own, so `held-when-late` is the safe value. Not observed: a steer lost at turn end. |
| `nativePermission` | `in-turn` | `session/request_permission` comes only inside `session/prompt`. After a background command's turn and after a timer's turn, neither side sent a frame until the client's next prompt, 30 s and 45 s later (`background-command.ndjson`, `schedule-timer.ndjson`); the command and the timer both ended inside their own turn. `prompt()` in `server.py` is the only reader of the step stream. |
| `nativeAsk` | `answerable` | The `ask_question` tool shows as `tool_call` id `interaction_<8 hex>` plus `session/request_permission` whose options are the answers; the selected `optionId` is the answer (`interaction-question.ndjson`). |
| `nativeSubagents` | `turn-held` | `invoke_subagent` completes at once; the child runs inside the same `session/prompt`, which ends after the child returns (`subagent.ndjson`). Background commands and `schedule` timers also hold the turn open. |
| `childWork` | `none` | The child's tool calls arrive as top-level `tool_call` frames with no link to the `invoke_subagent` call. Child text is never streamed: `_stream_live_step` drops steps with a `parent_trajectory_id`. |
| `hookEvents` | `none` | Hooks from `hooks.json` run in-process (`hooks.py`, `ExternalPreToolCallDecideHook` and others). No hook frame exists in the ACP stream. |
| `humanPromptHold` | `acknowledgement` | The wire has no consumption signal; the prompt's own response is the only acknowledgement. |
| `nativeTimerTool` | `null` | The built-in `schedule` tool works, but its timer fires inside the same held turn (`schedule-timer.ndjson`: the turn stayed open 20 s and ended after the timer), so it never wakes an idle session. It also sends no `tool_call` frame. Squawk reads this field only to match a tool-call event by name (`workflows/run/turn-markers.ts`), and no event can carry `schedule`. |
| `costReport` | `per-turn` | The `session/prompt` result carries this turn's tokens (`usage.totalTokens`, `inputTokens`, `outputTokens`, `thoughtTokens`, `cachedReadTokens`, `cachedWriteTokens`). No frame carries a cost. See [Usage](#usage). |
| `claudeModelAliases` | `false` | Models are Gemini ids from `configOptions` (`config-options.ndjson`). |
| `turnStart` | `on-write` | No frame starts a turn; the turn is the `session/prompt` request. The runner reports `turn.started` when it writes the request. |
| `skillTriggerMidTurn` | `true` | `/probe-alpha` steered into a running turn ran the skill in that turn (`skill-midturn.ndjson`). |
| `skillUnknownName` | `silent` | `/no-such-skill` gets a model reply that names the known skills; no error frame (`skill-slash.ndjson`). |
| `skillsSeenBySession` | `live` | The probe created `probe-alpha` before `session/new` and `probe-beta` on disk after several turns of the same session; the next turn listed both (`skills-live.ndjson`, that turn only: a folder change sends no frame). That turn read 0 cached tokens. Earlier turns of the same session (`prompt-command.ndjson`, `prompt-edit.ndjson`, `permission-reject.ndjson`, `interaction-question.ndjson`) read 20,307 to 34,466 cached tokens. |

## Launch, detection and the host probe

| Measure | Value |
| --- | --- |
| `--version` | 2.6 s wall, 260 MB peak RSS, exit 0, no files written. Ten lines on stdout, including `Build label: 1.5.0` and `Built as //cloud/developer_experience/antigravity_extensions/acp_server:_agy_acp_server_bin`; two `SyntaxWarning` lines on stderr. |
| `initialize` | 2.1–3.2 s from spawn, no sign-in needed. `agentInfo {name: "antigravity-acp", title: "Google Antigravity", version: "1.5.0"}`. t3code expects the name "Antigravity ACP Server"; 1.5.0 does not send it. |
| `session/new` | 0.11–0.2 s; this starts the Go harness. |
| Disk | The `.par` runs from memory (`memfd`). Nothing unpacks to disk at launch; the t3code note of about 1 GB per launch does not hold for 1.5.0 on Linux. A first session writes a 17 MB `webm_encoder` to `$HOME/.gemini/antigravity/bin/`, about 1.5 MB for a session of ten turns under `$GEMINI_HOME/antigravity-acp/conversations/`, and glog files under `$TMPDIR`. |

**The host probe may spawn `agy --version`.** It costs about 2.6 s and 260 MB of memory once,
writes nothing and needs no credential. Its timeout must allow at least 5 s on a loaded host.
Read the version from the `Build label:` line. Model-catalog identity requests share one
version probe for the resolved executable’s file identity (path, device/inode, size, timestamps
and mode); replacing or modifying it triggers another probe. Credential identity is still read
on every catalog request.

**Launch through a symlink (owner decision D1).** The `.par` looks for `localharness_external`
in `dirname(abspath(argv[0]))`, which does not resolve symlinks, then next to
`sys.executable`; `ANTIGRAVITY_HARNESS_PATH` overrides both (`main.py`,
`_configure_localharness_path`). A bare `agy` symlink in another folder passes `initialize` but
fails `session/new` with error -32603 "Could not find default localharness binary"
(`harness-missing.ndjson`). Setting `ANTIGRAVITY_HARNESS_PATH` to the `localharness_external`
next to the symlink's real target fixes it. So the runner sets that variable from the resolved
binary path, or the install hint tells the user to link the whole folder.

## Sign-in

| Method | Headless | How |
| --- | --- | --- |
| `gemini-api-key` | Yes | `authenticate {methodId: "gemini-api-key"}` takes the key from `_meta` (`api-key`, `apiKey` or `api_key`) or from `GEMINI_API_KEY`. It writes `{"auth":{"type":"gemini-api-key"}}` to `$GEMINI_HOME/antigravity-acp/settings.json`, so later launches infer it. The code shows that without a key it still answers `{}` and `session/new` then fails with an auth error (not run). |
| `oauth-personal` | No, unless the browser can reach the agy host | The server opens a one-shot loopback listener at `http://127.0.0.1:<random port>/` for 300 s, prints the Google consent URL to stderr and opens it through `webbrowser` (`$BROWSER`). The redirect must reach that port, agy itself has no device-code or paste flow (`oauth/credential_manager.py`). Squawk captures `$BROWSER` in memory and offers a pasted redirect in its cockpit, then replays it to this listener on the host. Personal consent URL capture/cancellation was verified live; completing consent with real Google accounts remains the owner’s check. |
| `oauth-business` | Not probed | Gemini Enterprise sign-in through the same kind of browser flow. |
| `agent-platform` | Not probed | Vertex AI; needs `gcp.project` and `gcp.location` in `settings.json` and Google credentials. |

`AGY_ACP_FORCE_FILE_STORAGE=1` keeps ACP OAuth credentials in files instead of a keyring
(`oauth/credential_store.py`). Personal OAuth uses
`$GEMINI_HOME/antigravity-acp/acp_token.json` (`ccpa_connection/oauth_manager.py`;
confirmed by native file-access tracing). The harness's separately logged
`$HOME/.config/antigravity/plugin-secrets.json` is plugin state, not this OAuth token.
Named Squawk accounts relocate HOME and XDG_CONFIG_HOME too, while retaining links to
user native instructions and skills. Read-only Go symbol/disassembly inspection of 1.5.0
confirms `authstore.pluginFallbackPath` calls `os.UserConfigDir()` then joins
`antigravity/plugin-secrets.json`; on Linux that uses XDG_CONFIG_HOME or HOME/.config.
The live API-key runs did not access this plugin store. No credential values are copied into Squawk state.

## Models and the API host

Squawk's catalog opens a short-lived ACP session and reads native `configOptions`. It sets
each listed model with `session/set_config_option` to read that model's thinking choices,
without sending a prompt. On 1.5.0 the live table offered gemini-3.8/3.7/3.6/3.5-flash
(low/medium/high) and gemini-3.1-pro (low/high). A proxy-configured gemini-3-flash also
appeared with no thinking choices. Cache identity includes account, Build label and auth
material digested only in memory. A failed probe falls back to suggested presets.

The Go harness calls the Gemini API at `GOOGLE_GEMINI_BASE_URL` (it inherits the server's
environment) and sends the key as `x-goog-api-key`. The model list comes from a table in the
server (`model_selection.py`): `gemini-3.8-flash`, `3.7`, `3.6`, `3.5` and `gemini-3.1-pro`, each
with thinking levels. The API request names the base model and sends the thinking level apart.

CLI Proxy answers `gemini-3-flash` but refuses every base name in that table with 400
`model_not_found` (`model-error.ndjson`). Two routes worked:

- `AGY_ACP_DEFAULT_MODEL=gemini-3-flash`. agy sends an id that is not in its table to the API
  unchanged. But it then knows no context size for the model and sends **no `usage_update`**.
- A local shim that renames the model in the request path. The usage, background, subagent,
  timer, skill and option fixtures were recorded through it with agy's default model.

An API error does not become a JSON-RPC error. It becomes an `agent_message_chunk` starting
"Agent execution error:" and the turn ends with `stopReason: "end_turn"` (`model-error.ndjson`).
On task or catalog failure, Squawk captures bounded, redacted tails of stderr and native glog
INFO/ERROR files from the process's private TMPDIR in the server log before removing that directory.
This preserves native failure details that the ACP error message can omit.
`HSQ_ANTIGRAVITY_DEBUG=1` adds native `--debug` traces; it is off by default. macOS can write
these traces only to stderr, including the native `RAW WS MSG` trajectory entries.

## Usage

- The `session/prompt` result's `usage` sums this turn's model calls only, not the session so
  far (`prompt-text-usage.ndjson`). The first turn made one call: 14,264 tokens, equal to its
  `usage_update.used`. The second turn made two calls (`used` 14,585 then 14,709), and its
  result counts 29,294, about their sum.
- `usage_update {used, size}` comes after each model call and once at `session/new`
  (`used: 0`). `used` is the tokens now in the context window and `size` is the window
  (1,048,576). It is a snapshot of occupancy, not a running sum and not a cost.
- No frame reports a cost. The `/usage` slash command ("Show model token usage and quota
  limits") was not run.

## Tool frames

Squawk gives this agent's private MCP server the alias `squawk`. The native name
`mcp_<server>_<tool>` must fit 64 characters. With the shared `cezar_ci_<32 hex>` name,
1.5.0 rejects the longest Squawk tools at startup, then can fail the second prompt with
`unexpected end of JSON input` while rebuilding its executor. Both the failure and the
short-alias two-turn success were reproduced on Linux with personal OAuth and the full tool list.

- **Command** (`prompt-command.ndjson`): `tool_call` kind `execute`, status `pending`, `rawInput`
  `{CommandLine, Cwd, WaitMsBeforeAsync[, NotificationTimeoutSeconds]}`; then the permission
  request with the same `toolCallId`; then `tool_call_update` `in_progress` with `rawInput`
  `{command_line, working_dir}`; then `completed` with `rawOutput` `{commandLine, workingDir,
  exitCode, exit_code, combinedOutput, formatted_output}`.
- **Edit** (`prompt-edit.ndjson`): `tool_call` kind `edit`, title `Run edit_file?`, `content`
  `[{type: "diff", path, oldText, newText, _meta: {kind: "modify"}}]`, `rawInput` `{TargetFile,
  TargetContent, ReplacementContent, StartLine, EndLine, …}`; completed `rawOutput`
  `"Edit notes.txt"`. The harness writes the file itself, since the client did not advertise
  `fs.writeTextFile`. With `fs.readTextFile` advertised, agy reads files through
  `fs/read_text_file` (tool title `Running client_view_file`).
- **Permission options**: a command offers `allow_always` (with `_meta["agy.security.warning"]`),
  `allow` (`allow_once`) and `deny` (`reject_once`); an edit offers `allow` and `deny`. A denial
  closes the call with status `failed`, `rawOutput: "Rejected by user"`
  (`permission-reject.ndjson`).
- **Question** (`interaction-question.ndjson`): `tool_call {toolCallId: "interaction_<8 hex>",
  title: <question>, status: "pending", rawInput: {}}`, then `session/request_permission` whose
  options are the answers, each with kind `allow_once` (`{optionId: "1", name: "red"}`). Select an
  `optionId` to answer; agy closes the call with `rawOutput: "Response received"`. Route by the
  `interaction_` prefix, since every option has kind `allow_once`.
- **Subagent** (`subagent.ndjson`): `tool_call` kind `other`, title `Run invoke_subagent?`,
  status `pending`, `rawInput` `{Subagents: [{Model, Prompt, Role, TypeName}]}`; the permission
  request carries the same `rawInput`. The `in_progress` update has title
  `Running invoke_subagent` and an empty `rawInput`, and the call completes at once with
  `rawOutput: "Tool execution"`. The child's own calls follow as ordinary top-level calls.
- **Tool call ids** take three forms: 32 hex digits, `call_<digits>`, and `<sessionId>:<n>` (yolo
  mode).
- **Modes** `default`, `auto_edit` and `yolo` are accepted; `session/set_mode` answers `{}`. In
  `yolo` a command runs with no permission request (`mode-yolo.ndjson`). The mode is saved with
  the session and comes back on resume.
- **Options**: `session/new` returns `configOptions` `model`, `thinking_level` (category
  `thought_level`) and `mode`. `session/set_config_option` changes them and returns the new
  list; an unknown model returns error -32602 with `availableModels` (`config-options.ndjson`).
- **Other frames at `session/new`**: `usage_update` and `available_commands_update` (`plan`,
  `logout`, `usage`) come before the response.
- **MCP**: `mcpCapabilities` offers `http` and `sse`, not `stdio`.

## Permissions in default mode

In the `default` mode agy allows its read-only tools and asks for every other tool
(`policy.safe_defaults` in the SDK: `allow` for the read-only set, then `ask_user("*")`).
`server.py` adds an explicit allow for `ask_question`, an explicit ask for `read_url_content`,
and a pre-tool hook that denies file access outside the allowed folders. A live probe with
`fs.readTextFile` and `fs.writeTextFile` both `false` and one HTTP MCP server gave:

| Tool | Asks | Evidence |
| --- | --- | --- |
| `view_file` in the workspace | No | `tool_call` `Running view_file`, kind `read`, no request (`permission-view-list-search.ndjson`) |
| `view_file` outside the workspace | No: denied | The pre-tool hook denies it ("Access to path … is denied. It is outside the allowed workspace directories") with no frame and no request. The model then ran `cat` through `run_command`, which asked (`view-file-outside-workspace.ndjson`). An allowed `run_command` therefore reaches files outside the workspace. |
| `list_directory`, `search_directory`, `find_file` | Not offered | Off by default in the SDK; the model answered that it had no such tool (`permission-view-list-search.ndjson`). There is no grep tool; a search runs through `run_command`. |
| `run_command` | Yes | `prompt-command.ndjson` |
| `create_file` | Yes | `Run create_file?`, kind `edit`, options `allow` and `deny` (`permission-create-file.ndjson`) |
| `edit_file` | Yes | `prompt-edit.ndjson` |
| `invoke_subagent` | Yes | `Run invoke_subagent?`, kind `other`; the child's own tools ask again (`subagent.ndjson`) |
| `search_web` | Yes | `Run search_web?`, kind `search`; it then called `read_url_content`, which asked too (`permission-search-web.ndjson`) |
| `read_url_content` | Yes | `Run read_url_content?`, kind `fetch` (`permission-read-url.ndjson`) |
| MCP tool | Yes | Title `<server>_<tool>` (`probe_echo`), kind `other` (`permission-mcp-echo.ndjson`; the HTTP server is in `permission-handshake-mcp.ndjson`) |
| `generate_image` | Yes | `Run generate_image?`, kind `other`; the image call itself failed at CLI Proxy (`permission-generate-image.ndjson`) |
| `ask_question` | No | The question is itself the request (`interaction-question.ndjson`) |
| `schedule`, `finish` | No | Read-only set; `schedule` sends no `tool_call` at all (`schedule-timer.ndjson`) |

In `yolo` mode nothing asks (`mode-yolo.ndjson`). `auto_edit` was not probed.

## Session lifecycle

- **Cancel** (`cancel.ndjson`): after the `session/cancel` notification, agy sends the chunks
  "context canceled" and "The request was cancelled by the client.", closes the open tool call
  as `failed`, and answers the prompt with `stopReason: "cancelled"` 13 ms later. The next
  prompt works.
- **Resume**: `session/resume` answers in about 0.2 s with `modes`, `models` and `configOptions`, and replays
  nothing (one `available_commands_update`). The conversation history is kept.
- **Load** (`load-replay.ndjson`): `session/load` replays the history as `user_message_chunk`,
  `agent_message_chunk`, `tool_call` and `tool_call_update` frames before its response.
- **List** (`session-list.ndjson`): `session/list` returns `{sessionId, cwd, title}` per saved
  session.

## Skills

The skill list at `session/new` (the reason hearsay-tools/cezarion#1267 removed Cursor's ACP
runner) is not fixed for agy: skills are read live each turn. agy reads these folders, in this
order (`resolve_skills_paths` in `server.py`; confirmed live in `skill-folders.ndjson` with one
skill per candidate folder):

1. `$GEMINI_HOME/config/skills`
2. `<dir>/.gemini/skills` for the cwd and each `additionalDirectories` entry
3. `$GEMINI_HOME/antigravity-cli/skills`
4. `<dir>/.agents/skills` for the cwd and each `additionalDirectories` entry

`GEMINI_HOME` defaults to `~/.gemini`. agy also lists built-in harness skills (`run-workflow`).
It does not read `$HOME/.gemini/...` when `GEMINI_HOME` points elsewhere, `~/.agents/skills`,
`~/.claude/skills`, `<cwd>/.agent/skills` or `<cwd>/.claude/skills`.

The harness binary names plugin sources (`<cwd>/.agents/plugins/`, `~/.gemini/config/plugins/`,
`~/.gemini/extensions/`, `~/.claude/plugins/`, with `plugin.json` under `.antigravity-plugin/`,
`.gemini-plugin/` or `.claude-plugin/`). A test plugin with a guessed manifest and a `skills/`
folder was not listed, so plugin skills are unconfirmed.

ACP has no call that lists skills: `available_commands_update` holds only `plan`, `logout` and
`usage`. The skill catalog has to read the folders above itself. A prompt that starts with
`/<skill name>` makes the model read that skill's `SKILL.md` and follow it (`skill-slash.ndjson`).

## Wire hazards

These are not parity gaps, but the runner must handle them:

1. **The steered prompt's response.** The second `session/prompt` is answered early with
   `stopReason: "end_turn"`, and agy injects an `agent_message_chunk` "Agent connection was lost
   and could not be re-established: Concurrent receive_steps() calls are not supported on this
   connection." into the running turn's text (`midturn-prompt.ndjson`). The SDK sends the
   steered text to the harness before that error. The runner drops this chunk and must not
   read the early response as the end of the running turn.
2. **Errors as text.** Provider and harness errors end the turn normally, with the error as
   message text (`model-error.ndjson`).
3. **Background notifications as text.** When a background command or timer reports, the
   model sometimes repeats the harness's `<SYSTEM_MESSAGE>` notice verbatim in its answer
   (`midturn-prompt.ndjson`, `cancel.ndjson`).
4. **Commands that go to the background.** A command still running after `WaitMsBeforeAsync`
   moves to the background; its `tool_call` stays `in_progress` and closes when it ends, still
   inside the held turn (`background-command.ndjson`).

## Runner integration choices verified live

A follow-up on the same 1.5.0 build verified the runner fixes for
hearsay-tools/squawk#4004 with isolated `HOME`, `GEMINI_HOME` and `TMPDIR` on the host:

- `agy --version` prints a multi-line banner. `Build label:` supplies the version.
- Model ids are opaque. A bare `gemini-3-flash` id passed unchanged through the runner and
  completed a turn through CLI Proxy. Slashes inside an id also belong to the native id.
- The harness sorts active workspaces and chooses the first as its default command cwd.
  Squawk omits `additionalDirectories` so the task checkout remains that directory. A live
  command without `Cwd` returned the task worktree. The same turn appended to the absolute
  handoff path under `.ai/squawk/runs` and wrote to `.ai/squawk/t/<task>` and `$TMPDIR` through
  shell tools. Native `view_file` outside-workspace restrictions still apply.
- `_meta.antigravity.eagerMcpServers` takes exact MCP server names (`mcp_servers.py`). Squawk
  sends its bridge name on new and resume so lifecycle tools are available without first
  reading the lazy tool files. The live model called `cezar_done` through that bridge.
- The harness writes `skills/system/run-workflow/SKILL.md` in the ACP workspace when native
  `run_workflow` is enabled. Moving the outer process cwd does not prevent this. A three-way
  session-opening probe found the file with defaults and no file with either
  `disabledTools: ["run_workflow"]` or `disabledTools: ["run_workflow", "start_subagent"]`.
  Squawk deliberately sends only `disabledTools: ["run_workflow"]` on new and resume:
  Squawk owns workflows, while native `start_subagent` remains available. This prevents the
  generated skill from entering autosave without deleting or ignoring user files.
- `available_commands_update` is a benign command catalog update. The mapper ignores it.
  MCP tool display names come from `_meta.mcp.tool`, while permission matching retains the
  native server-qualified name too.
- Cancellation must keep ACP open for failed tool updates and the cancelled prompt response.
  Native command processes can use detached sessions and survive harness exit. The runner
  captures descendant process identities before shutdown and reaps observed descendants
  even after reparenting. This is bounded cleanup, not containment of processes that escape
  before the snapshot. Open tool items also close as failed at a terminal turn boundary.
- Native `interaction_` answers accept only an offered `optionId`. Squawk hides free-text
  answers for these questions. Unsupported option counts cancel visibly; an invalid answer
  cancels the native request with a notice so the question cannot hang.

## Gaps that need a parity exemption

Wire gaps, each a `mock.parityExemptions` entry or a named exemption in `ui-parity.test.ts`:

| Criterion | Kind | Wire reason |
| --- | --- | --- |
| `plan.updated with entries` (UI parity matrix) | capability-absent | agy 1.5.0 sends no ACP `plan` update; `/plan` writes a plan artifact instead. |
| D1 (governed cross-session controls) and D3 (native cross-session messaging) | capability-absent | agy 1.5.0's built-in tools (`types.BuiltinTools`) include no cross-session tool. The harness carries a `swarm` plugin and an in-session message bus for background-task notices; neither showed as a tool in these sessions. Confirm when the runner exists. |
| I2 (accepted input left unread) | capability-absent | A steer is read in the running turn or runs as its own prompt, as for Pi; no observed case leaves it unread. Confirm when the runner exists. |

Gaps the declared facts already cover, with no entry: hook items (`hookEvents: 'none'`),
background subagent items (`nativeSubagents: 'turn-held'`), nested child work
(`childWork: 'none'`) and late permission requests (`nativePermission: 'in-turn'`).

Limits that are not parity cells, but that the runner must state:

- No cost on the wire. Token counts exist per turn.
- `usage_update` is absent for a model outside agy's table, which includes every route through
  CLI Proxy without a renaming shim. The runner can still report per-turn usage from the
  `session/prompt` result.
- Squawk's tools must reach agy over HTTP or SSE MCP; stdio MCP is not offered.
- No skill list call (see [Skills](#skills)).

## Frames not produced

Every frame the issue asks for was recorded. Completed real personal/business OAuth consent,
Agent Platform sign-in, and a plugin skill with a correct manifest were not run. The accounts
follow-up verified personal consent capture/cancellation, two isolated API-key sessions, native
model/thinking discovery, and both linked user and project skill triggers on the real build.

## Fixtures

Each line of a fixture is `{"t": <seconds since the agent started>, "from": "client" | "agent",
"frame": <JSON-RPC frame>}`. Host paths are replaced with `/work/...`. No key, token or email is
in them. Frame order and timing are as recorded.

| File | What it shows |
| --- | --- |
| `handshake.ndjson` | `initialize`, `authenticate`, `session/new` with a system prompt |
| `prompt-text-usage.ndjson` | Two turns: thought chunks, text, `usage_update` per model call, per-turn `usage` |
| `prompt-command.ndjson` | A command with its permission request |
| `prompt-edit.ndjson` | `fs/read_text_file`, then an edit with a diff and its permission request |
| `permission-reject.ndjson` | A denied command |
| `interaction-question.ndjson` | A native question and its answer |
| `midturn-prompt.ndjson` | A second prompt while a command runs |
| `midturn-prompt-late.ndjson` | A second prompt after the last tool result |
| `cancel.ndjson` | `session/cancel` during a command, then a working turn |
| `resume-without-system-prompt.ndjson` | `session/resume` without `_meta`; the system prompt is gone |
| `resume-with-system-prompt.ndjson` | `session/resume` with `_meta` resent |
| `load-replay.ndjson` | `session/load` history replay |
| `background-command.ndjson` | A background command that holds the turn; no frame in the 30 s before the next prompt |
| `subagent.ndjson` | `invoke_subagent` and the child's command |
| `schedule-timer.ndjson` | A `schedule` timer that holds the turn; no frame in the 45 s before the next prompt |
| `mode-yolo.ndjson` | `session/set_mode yolo`, then a command with no permission request |
| `config-options.ndjson` | `session/set_config_option` for effort, model and an unknown model |
| `skills-live.ndjson` | The turn after a skill folder was added on disk mid-session: the listing names it (the addition itself sends no frame) |
| `skill-slash.ndjson` | `/probe-alpha` and `/no-such-skill` |
| `skill-midturn.ndjson` | `/probe-alpha` steered into a running turn |
| `skill-folders.ndjson` | The skill folders agy reads |
| `session-list.ndjson` | `session/list` |
| `model-error.ndjson` | A provider 400 as message text and `end_turn` |
| `harness-missing.ndjson` | `session/new` through a bare `agy` symlink |
| `permission-handshake-mcp.ndjson` | `initialize` with `fs.readTextFile: false` and `session/new` with one HTTP MCP server |
| `permission-view-list-search.ndjson` | `view_file` with no request; no list or search tool |
| `permission-create-file.ndjson` | `create_file` with its request |
| `permission-search-web.ndjson` | `search_web` and the `read_url_content` it calls, both with requests |
| `permission-read-url.ndjson` | `read_url_content` with its request |
| `permission-mcp-echo.ndjson` | An MCP tool call with its request |
| `permission-generate-image.ndjson` | `generate_image` with its requests |
| `view-file-outside-workspace.ndjson` | A denied outside read, then `cat` through `run_command` |

The CLI 1.5.14 fixtures follow the same format. The live turns ran through the model-renaming
shim (see [CLI models and the API host](#cli-models-and-the-api-host)). Each `cli-*.expected.json` is
what today's mapper makes of the frames (see
[What today's mapper does with CLI frames](#what-todays-mapper-does-with-cli-frames)).

| File | What it shows |
| --- | --- |
| `cli-handshake.ndjson` | `initialize`, `authenticate`, `session/new` with a system prompt, two HTTP MCP servers and `_meta` |
| `cli-auth-no-key.ndjson` | `authenticate gemini-api-key` with no key, then `session/new` before sign-in |
| `cli-oauth-headless.ndjson` | `authenticate oauth-personal` with no display |
| `cli-config-options.ndjson` | An unknown model refused by `session/set_config_option` and `session/set_model`, a valid change, and a provider 400 as "⚠ agent executor error:" text |
| `cli-modes.ndjson` | `session/set_mode yolo` refused, `accept-edits` accepted |
| `cli-mcp-two-turn.ndjson` | Two turns with MCP calls through `squawk` and `cezar_ci_<32 hex>` |
| `cli-mcp-name-limit.ndjson` | A 65-character tool name dropped with no wire error; the 64-character one works |
| `cli-prompt-command.ndjson` | A command with its permission request |
| `cli-permission-reject.ndjson` | A denied command; the turn ends at once |
| `cli-prompt-edit.ndjson` | `read_file` with no request, then `edit_file` with its request and diff |
| `cli-midturn-prompt.ndjson` | A second prompt while a command runs: the first prompt ends early, the second carries the turn |
| `cli-cancel.ndjson` | `session/cancel` during a command, then a working turn |
| `cli-interaction-question.ndjson` | `ask_question` as text with `end_turn`, then the next prompt as the answer |
| `cli-subagent.ndjson` | `invoke_subagent`, `manage_subagents`, `send_message` and the child's command |
| `cli-background-command.ndjson` | A background command; its completion and the agent's text arrive after the turn |
| `cli-permission-after-turn.ndjson` | A permission request after the turn ended |
| `cli-schedule-timer.ndjson` | A `schedule` timer that fires after the turn and wakes the session |
| `cli-resume-without-system-prompt.ndjson` | `session/resume` without `_meta` in a new process; the saved system prompt still answers |
| `cli-resume-with-system-prompt.ndjson` | `session/resume` with `_meta` resent |
| `cli-resume-changed-system-prompt.ndjson` | `session/resume` with a different prompt; both prompts answer |
| `cli-session-list.ndjson` | `session/list` with `updatedAt` |
| `cli-load-replay.ndjson` | `session/load` history replay |
| `cli-skill-folders.ndjson` | The skills the model lists, one per folder the CLI reads (the session's `available_commands_update` is in `cli-interaction-question.ndjson`) |
| `cli-skills-live.ndjson` | A skill added mid-session, `/sk-late` and `/no-such-skill` |
