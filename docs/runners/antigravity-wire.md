# The Antigravity ACP wire (agy 1.5.0)

This note records what Google's Antigravity ACP server does on its wire, measured live on
2026-11-21 for hearsay-tools/squawk#4000. The Antigravity runner (hearsay-tools/squawk#4004)
reads its facts from here. The recorded frames are in
[`packages/cezar/src/runners/antigravity/__fixtures__/`](../../packages/cezar/src/runners/antigravity/__fixtures__/).

In short: agy speaks ACP protocol version 1 over stdio. It mints its own session ids, steers a
second prompt into the running turn, asks native questions through `session/request_permission`,
holds a turn open while subagents, background commands and timers run, and reports tokens per
turn with no cost. The system prompt does not survive `session/resume`.

## What was run

| Item | Value |
| --- | --- |
| Build | ACP registry archive `antigravity-acp` 1.5.0, `agy-acp-server-1.5.0-linux-x86_64.zip` (sha256 `36f373e8…808c9f`) |
| Files | `agy_acp_server.par` (714 MB, an embedded Python 3.14 program) and `localharness_external` (140 MB, a Go harness that the `.par` starts per session and talks to over a localhost websocket) |
| Command | `agy_acp_server.par --uid=`. There is no `acp` subcommand and no `--login`, `--gemini-dir` or `--app-data-dir` flag. The program's own flags are `--debug` and `--notices` |
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
| `skillsSeenBySession` | `live` | The probe created `probe-alpha` before `session/new` and `probe-beta` on disk after six turns of the same session; the next turn listed both (`skills-live.ndjson`, that turn only: a folder change sends no frame). That turn read 0 cached tokens, while the turns before it read 12,000 or more. |

## Launch, detection and the host probe

| Measure | Value |
| --- | --- |
| `--version` | 2.6 s wall, 260 MB peak RSS, exit 0, no files written. Ten lines on stdout, including `Build label: 1.5.0` and `Built as //cloud/developer_experience/antigravity_extensions/acp_server:_agy_acp_server_bin`; two `SyntaxWarning` lines on stderr. |
| `initialize` | 2.1–3.2 s from spawn, no sign-in needed. `agentInfo {name: "antigravity-acp", title: "Google Antigravity", version: "1.5.0"}`. t3code expects the name "Antigravity ACP Server"; 1.5.0 does not send it. |
| `session/new` | 0.11–0.2 s; this starts the Go harness. |
| Disk | The `.par` runs from memory (`memfd`). Nothing unpacks to disk at launch; the t3code note of about 1 GB per launch does not hold for 1.5.0 on Linux. A first session writes a 17 MB `webm_encoder` to `$HOME/.gemini/antigravity/bin/`, about 1.5 MB for a session of ten turns under `$GEMINI_HOME/antigravity-acp/conversations/`, and glog files under `$TMPDIR`. |

**The host probe may spawn `agy --version`.** It costs about 2.6 s and 260 MB of memory once,
writes nothing and needs no credential. Its timeout must allow at least 5 s on a loaded host.
Read the version from the `Build label:` line.

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
| `oauth-personal` | No, unless the browser can reach the agy host | The server opens a one-shot loopback listener at `http://127.0.0.1:<random port>/` for 300 s, prints the Google consent URL to stderr and opens it through `webbrowser` (`$BROWSER`). The redirect must reach that port, so a remote host needs an SSH port forward. There is no device-code or paste flow (`oauth/credential_manager.py`). Not completed in this probe: the owner chose CLI Proxy. |
| `oauth-business` | Not probed | Gemini Enterprise sign-in through the same kind of browser flow. |
| `agent-platform` | Not probed | Vertex AI; needs `gcp.project` and `gcp.location` in `settings.json` and Google credentials. |

`AGY_ACP_FORCE_FILE_STORAGE=1` keeps stored credentials in files instead of a keyring
(`oauth/credential_store.py`); the harness logged `$HOME/.config/antigravity/plugin-secrets.json`.

## Models and the API host

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

Every frame the issue asks for was recorded. Three things were not run: the OAuth sign-ins
(the owner chose CLI Proxy), Agent Platform sign-in, and a plugin skill with a correct
manifest.

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
| `skills-live.ndjson` | A skill added after `session/new`, listed next turn |
| `skill-slash.ndjson` | `/probe-alpha` and `/no-such-skill` |
| `skill-midturn.ndjson` | `/probe-alpha` steered into a running turn |
| `skill-folders.ndjson` | The skill folders agy reads |
| `session-list.ndjson` | `session/list` |
| `model-error.ndjson` | A provider 400 as message text and `end_turn` |
| `harness-missing.ndjson` | `session/new` through a bare `agy` symlink |
