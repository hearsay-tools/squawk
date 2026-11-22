# The Antigravity ACP wire (CLI 1.5.14)

This note records what Google's Antigravity CLI does on its ACP wire (`antigravity acp`),
measured live on 2026-11-22 for hearsay-tools/squawk#4058. The Antigravity runner reads its
facts from here since hearsay-tools/squawk#4060. The recorded frames are in
[`packages/cezar/src/runners/antigravity/__fixtures__/`](../../packages/cezar/src/runners/antigravity/__fixtures__/).
The registry server `agy_acp_server.par` 1.5.0, which the runner ran before, is no longer
supported; its record is in git history (hearsay-tools/squawk#4000).

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

Where a Google sign-in is stored: see [Runner integration probes](#runner-integration-probes-hearsay-toolssquawk4060). The binary
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
they were not probed. A provider error is still message text plus `end_turn`. The CLI writes every agent failure as
one message chunk, `"\n⚠ <error>\n"` (the binary's format string is `\n⚠ %s\n`). The error often
starts "agent executor error:" (1.5.0: "Agent execution error:") (`cli-config-options.ndjson`), but
not always: the 404 of hearsay-tools/squawk#4098 came as `"\n⚠ NOT_FOUND (code 404): Requested
entity was not found.\n"`, and a broken custom agent as `"\n⚠ failed to construct executor: …\n"`.

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
| `nativeSubagents` | `turn-held` | **`none`** since hearsay-tools/squawk#4098: Squawk denies the subagent tools | `invoke_subagent` completes at once and the child runs as a separate conversation (`brain/<child id>/`, `cli-subagent.ndjson`). A child's permission requests never reach the ACP client, so each command it needs approved times out after 60 s (see [Native subagents and tool results](#native-subagents-and-tool-results-hearsay-toolssquawk4098-hearsay-toolssquawk4099)). |
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
  between a parent and its subagents. Squawk denies both with the other subagent tools
  (hearsay-tools/squawk#4098), so the session still has no cross-session tool.
- `plan.updated with entries`: `plan` is now a mode and a command; no ACP `plan` frame was
  seen, but it was not probed.

### How the runner maps CLI frames

hearsay-tools/squawk#4060 maps the CLI frames as follows. The fixtures' expected files record it.

1. A tool still running when a prompt turn ends with `end_turn` stays open: a background
   command, a timer or a question completes in a later turn. A cancelled or failed turn closes
   it as failed, and a later update for a closed tool is dropped.
2. A steered prompt carries the turn: when the running prompt answers `end_turn` while a later
   prompt is pending, the turn stays open and the later prompt's response ends it, with the
   usage of both.
3. Work with no prompt open opens a turn the agent started. A `usage_update` right after
   message text ends it: every recorded agent step that makes no further tool call ends so, and
   after thoughts or a tool the same update starts the next step. A prompt sent while it runs
   joins it.
4. A message chunk in the failure shape `"\n⚠ <error>\n"` makes the turn end as `error` when it
   opens a message of its own and no other agent work follows it before the turn ends. Assistant
   text with a warning sign inside a reply, or followed by more work, stays text. After an
   accepted `cezar_done` the error is a diagnostic (a note and a non-fatal `session.error`), and
   the run keeps its result (hearsay-tools/squawk#4016).
5. MCP items take their server and tool from `mcp_<server>_<tool>`; Squawk's `squawk` server is
   matched by name, so its tools stay trusted.
6. An `ask_question` call becomes a question card. The answer goes as the next prompt.
7. The system prompt goes on `session/new` only, never on `session/resume`, so a resume adds no
   copy to the saved one. A resumed session gets it prepended to its opening turn
   (`systemPromptOnResume: 'in-thread'`).
8. `_meta.antigravity.disabledTools` and `eagerMcpServers` are no longer sent: the CLI ignores
   the first, does not know the second, and `run_workflow` writes no skill into the workspace.
9. Every session gets `--add-dir <session temp>/squawk-antigravity-guard`. Its `.agents/hooks.json`
   holds a `PreToolUse` hook that denies `invoke_subagent`, `define_subagent`, `manage_subagents`,
   `send_message`, `run_workflow` and `swarm` by whole name. The folder is outside the checkout
   and goes with the session's temp folder.
10. A read, MCP or subagent tool whose completed update carries no result gets its output from
    the session's transcript row, as an `item.updated` of the completed card marked `late: true`.
    Nudge accounting ignores it: it is a display update, not the agent's reply.

### Native subagents and tool results (hearsay-tools/squawk#4098, hearsay-tools/squawk#4099)

Measured live on Linux x86-64 on 2026-11-22 with CLI 1.5.14 and a personal Google sign-in, no
shim, through a JSON-RPC driver with a local HTTP MCP server.

**Native subagents.** A subagent's permission requests never reach the ACP client: no
`session/request_permission` arrives, for the parent's session id or another. Each command the
child needs approved fails after 60 s ("permission check timed out waiting for a user response
after 60s"; the CLI log says `context deadline exceeded`). In the failed run of
hearsay-tools/squawk#4098 five such children ran, and the parent's next model call failed with
Google's `NOT_FOUND (code 404)`; one child did not reproduce the 404. The log line
`agy_tool_safety triggered=true reason="unsupported_tool: invoke_subagent"` is not the cause: the
same line appears for `write_file`, `edit_file` and MCP tools, and only hands the call to the
model-based monitor.

Routes to turn the tools off:

| Route | Result |
| --- | --- |
| `_meta.antigravity.disabledTools` on `session/new` | ignored (see [`_meta.antigravity`](#_metaantigravity)) |
| A hidden main agent (`agents/<name>.md` with `mainAgent: true` and a `tools` list) chosen with `--agent` | The listed tools hold, but the agent's body replaces the CLI's identity prompt ("You are Antigravity, …"), and every MCP server passed on `session/new` is gone: `inheritMcp`, a `mcpServers` list of names, of objects or a map bring none back, and an MCP name in `tools` fails with "unknown component". An agent the CLI cannot resolve falls back to the default agent with only a log line (`Agent "<name>" not found, falling back to default`). Not used. |
| A `PreToolUse` hook (`.agents/hooks.json`) returning `{"decision":"deny","reason":…}` | The call closes `failed` with no permission request; the agent reads "tool call denied by pre-tool hook: <reason>" and goes on with its turn (`cli-tool-output.ndjson`). The system prompt and MCP tools stay. Used. |

`--add-dir` makes the CLI read `.agents/` from the added folder, as from the workspace. With a
folder that sorts before the workspace (`/tmp/…/extraH` before `/tmp/…/ws1`), `pwd` in a command
still printed the workspace, and `write_file` with a relative name wrote into the workspace. The
model sees the added folder as a workspace root.

**Tool results.** Completed `tool_call_update`s for `read_file`, an MCP call (success and
`isError`), and a denied `invoke_subagent` carry no `content`, no `rawOutput` and no `_meta`
(`cli-tool-output.ndjson`). Only `run_command` (`rawOutput`) and `edit_file` (`content` diff)
carry results. The CLI keeps what the agent received in
`<gemini-dir>/<app-data-dir>/brain/<sessionId>/.system_generated/logs/transcript_full.jsonl`, one
JSON row per step (`cli-tool-output.transcript.jsonl`):

- A `PLANNER_RESPONSE` row lists the step's `tool_calls` as `{name, args}`; `args` equal the
  wire's `args`, `toolSummary` included. The k-th call's result is the row with
  `step_index` = planner `step_index` + 1 + k. `SYSTEM_MESSAGE`, `USER_INPUT` and `CHECKPOINT`
  rows hold no result.
- A result row has `status` `DONE` or `ERROR` (with `error`), and `content` that starts with
  `Created At:`/`Completed At:` lines.
- The row is sometimes written after the wire's completed update: for one of four calls it was
  missing when the update arrived.

This is the CLI's private format. Squawk reads only the run's own account folder and session,
from the file's size when the session opened, at most 4 MiB a read, a row up to 8 MiB and an
output up to 64 Ki characters, and it waits at most 10 s after a tool completes. A missing file
or rows in another shape leave the card with no output. The golden
`cli-tool-output.outputs.json` pins the mapping for CLI 1.5.14.

### Runner integration probes (hearsay-tools/squawk#4060)

Measured live on Linux x86-64 on 2026-11-22 with the same driver and shim.

- **Late steer.** A second prompt sent while the final text of a tool-free turn streamed ended
  the first prompt with `end_turn` (no `usage`) 5 ms later. The agent then ran one more model
  step and its answer obeyed the steer; the second prompt's response ended the turn. The steer
  is read in the running turn: `humanInputAtTurnEnd` is `never-held`.
- **Prompt during work after the turn.** A prompt sent while the agent wrote text after a
  background command ended joined that work: the answer obeyed it, and its response ended it.
- **Google sign-in status.** With `SSH_CONNECTION` set and no stored sign-in, `authenticate
  oauth-personal` answered -32603 "No browser is available here (this is a remote (SSH)
  session, …)" at once and ran no `BROWSER` command, even with `DISPLAY` set. Without
  `SSH_CONNECTION` it waited and did not answer within 20 s.
- **Where a Google sign-in is stored.** No Google account was used. A local TLS interceptor with
  a test CA (`SSL_CERT_FILE`, `HTTPS_PROXY`) answered the CLI's token exchange
  (`POST oauth2.googleapis.com/token`) and user info call with fake values, so `antigravity acp
  --login` completed with a pasted bare code. With `SSH_CONNECTION` set, each account's sign-in
  went to one file, `<gemini-dir>/<app-data-dir>/antigravity-oauth-token` (mode 0600, JSON keys
  `auth_method` and `token`), and `cache/acp-auth-state.json` became
  `{"methodId":"oauth-personal"}`. Two accounts got two different files; nothing was written under
  `HOME` or `XDG_CONFIG_HOME`. A session process with `SSH_CONNECTION` then answered `authenticate
  oauth-personal` with `{}` for each signed-in account and refused the account with no file. The
  binary has an SSH keyring detector (`code_assist_client/keyring_detector_ssh.go`) beside D-Bus,
  container, WSL and Termux detectors, and a composite keyring-and-file token storage. This host
  has no D-Bus session bus, so a run without `SSH_CONNECTION` also wrote the file here. Where a
  host with an OS keyring (macOS, a Linux desktop) puts the token without `SSH_CONNECTION` was not
  measured; t3code reports one keyring entry for every account. Squawk always sets
  `SSH_CONNECTION`, in the sign-in process and in every session and probe process.

## Fixtures

Each line of a fixture is `{"t": <seconds since the agent started>, "from": "client" | "agent",
"frame": <JSON-RPC frame>}`. Host paths are replaced with `/work/...`. No key, token or email is
in them. Frame order and timing are as recorded. The live turns ran through the model-renaming
shim (see [CLI models and the API host](#cli-models-and-the-api-host)). Each `cli-*.expected.json` is
what the mapper makes of the frames.

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
| `cli-tool-output.ndjson` | A read, an MCP result, the same read again, an MCP `isError` result and an `invoke_subagent` denied by Squawk's hook; no completed update carries a result. Recorded with a Google sign-in, no shim. `cli-tool-output.transcript.jsonl` is the session's transcript; `cli-tool-output.outputs.json` the output Squawk reads from it for each call |
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
