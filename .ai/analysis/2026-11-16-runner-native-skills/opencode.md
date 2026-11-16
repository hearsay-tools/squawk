# Skill probe: opencode

- Runner: `opencode` 1.19.4 (`opencode --version`), default account, probed 2026-11-16.
- Model for every turn: `zai-coding-plan/glm-5.3-flash`. Model turns used: 12 of 12.
- Scratch repo cwd for all probes: `/tmp/skill-probe-opencode.<rand>/repo` (removed after the run).
- Every claim is marked TESTED, DOCS or NOT TESTED.

## Answers

- **LIST: yes.** `GET /skill` on the `opencode serve` process Squawk already starts. No session, no model call, about 0.1 s on the first call. `GET /command` returns the same skills as commands (`source: "skill"`). A CLI route also exists: `opencode debug skill`.
- **TRIGGER: yes, but not through the request Squawk sends today.** `POST /session/{id}/command` with `{command: "<skill name>", arguments: "..."}` makes the runner put the skill body into the user message itself. Text sent through `POST /session/{id}/prompt_async` (Squawk's only prompt route) is never expanded; `/probe-alpha` there is plain text and the model decides whether to call the `skill` tool.

## Step 0: how Squawk drives this runner

Source: `packages/cezar/src/core/opencode-server-runner.ts` (line numbers at commit `00958e289`).

| Fact | Evidence |
|---|---|
| Transport: one `opencode serve` child per session, HTTP + SSE | L609: `spawnSessionLeader(bin, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: spec.cwd, env })`; port is random in 40000..59999 (L606); the URL is read from stdout (L700) |
| Env: `OPENCODE_CONFIG_CONTENT` is set only to merge Squawk's MCP server (`ci-wait/injection.ts`) and the task-scope plugin (`core/opencode-task-scope.ts`) into a config the user already supplied | L611 |
| No permission config. Squawk does not start the server with a "do not ask" config. It answers the built-in asks (`external_directory`, `doom_loop`, `read`) with `once` through `POST /permission/{id}/reply` when no user rule names that permission, and sends other asks to the cockpit | `core/opencode-permissions.ts` `OPENCODE_DEFAULT_ASK_PERMISSIONS`; runner L1335-1486 |
| No per-tool allowlist: `opencodeToolGrantFields` returns `{}` for every grant | `core/runner-tool-grants.ts` |
| Session: `POST /session {title}` for a new one; `GET /session/{id}` for resume, 404 falls back to a new session | L745-770 |
| Events: `GET /event` (SSE), subscribed before the first prompt; `session.idle` is the turn end | L977, L1089-1098 |
| First prompt and every later message: `POST /session/{id}/prompt_async` with body `{parts:[{type:'text',text}], model:{providerID,modelID}, variant}` | L816, L853-863, L869 |
| The system prompt is prepended to the opening text (`prependSystemPrompt`), so the opening text never starts with the user's own first characters | L783 |
| The `command` endpoint is not used anywhere in the adapter | `grep -n "command\|skill" opencode-server-runner.ts` finds only comments |
| Non-default account: none. `ACCOUNT_LAYOUT.opencode.select` is `null`, so Squawk sets no home variable for opencode; the default follows the host's `XDG_CONFIG_HOME` | `core/agent-profiles.ts:41`, `paths.ts` `agentHomePaths` |

The probes used the same launch (`opencode serve --hostname 127.0.0.1 --port <free port in 40000..59999>`, cwd = scratch repo, no extra config) and the same routes, with a small Node driver that subscribed to `/event` first and answered default asks with `once`.

## Results

| # | Verdict | Evidence |
|---|---|---|
| L1 List without a model call | **Yes. TESTED.** | `curl $B/skill` -> `200 620536B 0.104s`, before any session existed. Array of `{name, description, location, content}`; `location` is the absolute `SKILL.md` path or `<built-in>`; `content` is the full body. No scope or source field: scope must be read from `location`. 38 entries: 2 project, 7 user-level (`~/.agents/skills`, `~/.claude/skills`), 12 from `~/.claude/skills/.trash/...`, 16 plugin (`~/.cache/opencode/packages/<pkg>/.../skills/<name>/SKILL.md`), 1 built-in. Cold start: spawn to listening 0.73 s, spawn to list returned 0.82 s (load average 5.8 at that moment). |
| L1 other routes | TESTED | `GET /command` -> 41 entries `{name, description, source, template, hints}`; `source` is `skill` for 38 and `command` for 3. A skill's `template` is the body plus `Base directory for this skill: <dir>` and one line about relative paths. `GET /api/skill` -> `{location:{directory,project}, data:[{name,description,location,content}]}`. `opencode debug skill` (no server) prints the same array as `GET /skill`: 6.0 s on the first run in a folder, 0.9 s later. |
| L2 cwd | **Sensitive. TESTED.** | Same server, `GET /skill?directory=<other folder>` -> 36 entries, 0 project skills; `?directory=<repo>/sub/deep` -> 38, both project skills (found from a subfolder). The header `x-opencode-directory: <dir>` does the same. `opencode debug skill` from another cwd: 36, none of the fixtures. |
| L2 home variable | NOT TESTED (brief: cwd only) | Squawk sets none for opencode (Step 0). |
| T1 `/probe-alpha` as the whole `prompt_async` text | Token came back; **the MODEL loaded it.** TESTED | User part stayed `text: /probe-alpha`. Assistant part: `tool skill input={"name":"probe-alpha"}` -> `<skill_content name="probe-alpha">...`, then `text: ALPHA-96b85580`. No `command.executed` event. |
| T1 `POST /session/{id}/command` | Token came back; **the RUNNER loaded it.** TESTED | Body `{"command":"probe-alpha","arguments":"hello world","model":"zai-coding-plan/glm-5.3-flash"}`. The user message text is the skill body + `Base directory for this skill: .../.opencode/skills/probe-alpha` + `\n\nhello world`. No tool part in the turn. SSE: `command.executed {"name":"probe-alpha","sessionID":...,"arguments":"hello world","messageID":...}`. Reply: `ALPHA-96b85580: hello world`. |
| T1 other name forms on the command endpoint | Refused, no model call. TESTED | `skill:probe-alpha`, `/probe-alpha`, `$probe-alpha` each -> HTTP 500 and `session.error ... Command not found: "<name>"`. Only the bare name works. |
| T1 `$probe-alpha`, `/skill:probe-alpha` as `prompt_async` text | NOT TESTED | Turn budget. `prompt_async` expanded no text form in T1, T3 and T4. |
| T1 structured skill item | None exists. DOCS | `/doc`: `prompt_async` parts are `TextPartInput`, `FilePartInput`, `AgentPartInput`, `SubtaskPartInput`; `/api/session/{id}/prompt` takes `{text, files, agents}`. |
| T2 arguments | **Yes on the command endpoint. TESTED.** | Body without placeholders: arguments are appended as a last bare paragraph (above). Body with placeholders (`ARGS[$ARGUMENTS] FIRST[$1] SECOND[$2]`, arguments `hello world`): user text became `ARGS[hello world] FIRST[hello] SECOND[world]`, nothing appended; reply matched. In 1 of 5 runs with bare appended arguments the model treated the trailing text as incidental and returned the token without it. |
| T2 `/probe-alpha hello world` as `prompt_async` text | NOT TESTED | The `skill` tool takes only `name` (T1), so arguments would stay in the user text. |
| T3 mid-text "Say hi, then run /probe-alpha" | Model choice. TESTED | User part unchanged; assistant `text: Hi! Loading the probe-alpha skill now.` + `tool skill {"name":"probe-alpha"}`; then `ALPHA-96b85580`. No runner expansion. |
| T4 unknown name, `prompt_async` text `/probe-nope` | Plain text to the model. TESTED | No error event. Assistant: ``No skill named `probe-nope` exists. Available probe skills: `probe-alpha`, `probe-gamma`.`` One model turn was spent. |
| T4 unknown name, command endpoint | Error, no model call. TESTED | `POST .../command {"command":"probe-nope","arguments":""}` -> `500 {"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_..."}}` after 5 ms. SSE: one `session.error {"sessionID":"ses_...","error":{"name":"UnknownError","data":{"message":"Command not found: \"probe-nope\". Available commands: init, review, ..."}}}`. No `session.status`, no `session.idle`. |
| T5 prose "Use the probe-gamma skill." | Model called the `skill` tool. TESTED | `tool skill input={"name":"probe-gamma"}` -> `text: GAMMA-db49d2c2`. |
| T6 reference file | **Readable, no permission ask. TESTED.** | After the command trigger, "Now give me the extra token." -> `tool read {"filePath":".../.opencode/skills/probe-alpha/references/extra.md"}` -> `BETA-5c96cda6`. No `permission.asked` event. A skill outside the project (server started with `OPENCODE_CONFIG_CONTENT={"skills":{"paths":["/tmp/...ext"]}}`): command trigger -> `tool read .../probe-ext/references/extra.md` -> `ZETA-2ae61592`, again no `permission.asked`. `GET /agent` shows that OpenCode adds `external_directory <skill dir>/* allow` for every skill folder after its own `external_directory * ask`. This host's user config also has a scalar `permission` value (not read) that lands after those rules, so the test cannot say the generated rules alone prevented the ask. |
| T7 later message, same session | **Works. TESTED.** | Third message of the session: `command probe-gamma "second turn"` -> `command.executed`, reply `GAMMA-db49d2c2: second turn`. |
| T7 resume | **Works. TESTED.** | Server stopped by PID; new `opencode serve` on another port; `GET /session/<id>` -> 200; `command probe-alpha "after resume"` -> `command.executed`, reply `ALPHA-96b85580: after resume`. |
| T8 skill folder added after start | **Not seen by the running server; seen after a reload or a new process. TESTED.** | `.claude/skills/probe-delta` added while the server ran: `GET /skill`, `GET /command`, `GET /api/skill` still listed 2 fixtures; `command probe-delta` -> `Command not found`. A new `opencode debug skill` process listed it. After `POST /instance/dispose` (200, same process, session kept) both lists showed it and `command probe-delta "after dispose"` in the old session returned `EPSILON-c1888c8e: after dispose`. After a server restart (resume) it was listed too. Whether the model's own skill list updates inside an old session: NOT TESTED. |

### Folders, names, duplicates

| Topic | Verdict | Evidence |
|---|---|---|
| Project folders read | TESTED | One uniquely named skill per folder, then `opencode debug skill`: listed from `.opencode/skills`, `.opencode/skill`, `.claude/skills`, `.agents/skills`. Not listed from `.codex/skills`, `.cursor/skills`, `.pi/skills`, `.omp/skills`, `.github/skills`. Nested folders are read (`.opencode/skills/group/nested-one/SKILL.md` listed). A `.md` file not named `SKILL.md` is not. |
| Name charset | **Not enforced on 1.19.4. TESTED.** | Listed as skills and as commands: `Bad_Name`, a 70-character name, `plug:colon-name`. |
| Name must equal folder | **Not enforced. TESTED.** | Folder `folder-one` with `name: other-name` is listed as `other-name`. |
| Missing fields | TESTED | No `description`: listed with `description: null`. No `name`, or no frontmatter: not listed, no log line. |
| Malformed frontmatter | **Not fatal. TESTED (list path only).** | `description: "unterminated`: the skill is absent, valid skills in the same folder are listed, exit 0, HTTP 200, no `session.error` on `/event` or `/global/event`, no log line. Whether a turn emits the `session.error` warning that `opencode-session-error.ts` handles: NOT TESTED. |
| Same name in two folders | TESTED | One entry per name; the copy loaded last wins, and the log says `WARN "duplicate skill name" name=... existing=... duplicate=...`. `.opencode/skills` beat `.claude/skills` and `.agents/skills` (every run). A project copy beat a user-level copy of `notes` (2 of 2). Between `.claude/skills` and `.agents/skills` the winner is not stable: `.agents` won 5 of 6 `opencode debug skill` runs in one folder, `.claude` won 1. |
| Plugin-qualified names | TESTED for listing | The 16 plugin skills are listed under bare names (`setup`, `dev-flow`, `code-review`, ...); no listed name contains `:`. The command endpoint refuses `skill:probe-alpha`. A literal `name: "plug:colon-name"` is accepted as a plain name. Triggering a colon-named skill: NOT TESTED. |

## Surprises

1. The lead "start the server with a config that does not ask, as Squawk does" does not match the adapter. Squawk sets no permission config; it replies to asks over HTTP.
2. `POST /session/{id}/command` is a long poll: the HTTP response arrives when the turn ends (6.3 s, 10.4 s, 3.5 s in the runs above), and `/doc` has no async variant. When the client dropped the request after 0.4 s the turn still ran to `session.idle` and the reply was stored, but no `command.executed` event was sent.
3. The command body differs from `prompt_async`: `model` is a string `provider/model`, not an object; `arguments` and `command` are required; `variant` and `agent` exist; there is no `system` field and no text part.
4. The name rules and the fatal frontmatter error from the October tests are gone on 1.19.4 (table above).
5. A skill with sloppy but recoverable frontmatter (`description: has: a colon "and quote`) is listed on the first load in a process and missing after `POST /instance/dispose` or in any later folder with the same file content in the same server; `opencode debug skill` always lists it (2 server processes, 12 folders). Cause not established.
6. Skills under `~/.claude/skills/.trash/` are listed (12 on this host): the scan is recursive.
7. `GET /skill` returns full bodies, 620 KB here. `opencode debug skill | <reader>` is cut at exactly 131072 bytes; redirected to a file it is complete (621678 bytes).
8. `opencode debug skill` wrote `.gitignore`, `package.json`, `package-lock.json` and `node_modules/` into the project's `.opencode/` folder. It created no `.opencode/` where none existed.
9. `GET /skill?directory=<dir>` lets one server list skills for any folder.
10. `opencode serve` on a port another process holds exits 1 with only `Error: Unexpected error / ServeError`.

## Not tested, and why

- A non-default home (`XDG_CONFIG_HOME`): out of scope per the brief, and Squawk sets no account variable for opencode.
- `$probe-alpha`, `/skill:probe-alpha` and `/probe-alpha hello world` as `prompt_async` text: turn budget; that route showed model choice only.
- TUI slash input and `opencode run --command <name> [message]` (the flag exists in `opencode run --help`): not Squawk's transport, and one runner process at a time.
- Skill-declared `allowed-tools`, hooks or `!cmd` lines in a skill body: not in the brief.
- A command trigger while a turn is busy (steering), and under a user config whose rules ask for `skill` or `read`: turn budget.
- Whether the user's blanket `permission` value or OpenCode's generated skill-folder rules prevented the `external_directory` ask: the value is config content and was not read.

## Cleanup

- Servers started: PIDs 2844427, 2981014, 3009524, 3029060; each stopped with `kill -TERM <pid>` and confirmed gone. No opencode listener of this probe remains.
- Scratch folders `/tmp/skill-probe-opencode.jWFb9t` and `/tmp/skill-probe-opencode-ext.5477bc` removed.
- Left behind by the runner itself: 9 probe sessions in OpenCode's own data folder.
