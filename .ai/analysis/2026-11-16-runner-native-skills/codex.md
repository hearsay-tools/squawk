# Codex: native skill listing and native skill trigger

- Runner: `codex-cli 0.164.0` (`~/.local/bin/codex`), default account, probed 2026-11-16.
- Model for real turns: `gpt-5.6-luna`, effort `low` (from `model/list`; 9 model turns used of 12).
- Scratch: `/tmp/skill-probe-codex.6zPj5m` (git repo `repo/` with the fixture, `repo2/` for name rules). Removed at the end.

## Answers

| Question | Answer |
|---|---|
| LIST without a model call | **Yes.** `skills/list {cwds:[<dir>]}` on `codex app-server` after `initialize`. No thread needed. 8 to 34 ms per request, about 0.4 to 0.6 s for the whole process. |
| TRIGGER a named skill for certain | **Yes, on `turn/start` only.** Either `$<name>` anywhere in a text item, or a structured `{type:"skill", name, path}` input item. The app-server itself appends the SKILL.md body to the model request as a `<skill>` user message. **Not on `turn/steer`**: there both forms are passed through without the body. `/name` is never a trigger. |

## Step 0: how Squawk drives Codex

Read from `packages/cezar/src/core/codex-app-server-transport.ts`, `codex-app-server-runner.ts`, `codex-permissions.ts`, `runner-tool-grants.ts`.

- Transport: child process `codex app-server` (argv is exactly `['app-server']`), JSON-RPC as newline-delimited JSON on stdio. Spawn cwd is the task worktree.
- Startup sequence: `initialize {clientInfo:{name:'cezar',…}, capabilities:{experimentalApi:true}}` → notification `initialized` → `configRequirements/read {}` → `thread/start {model, cwd, …}` or `thread/resume {threadId, model, cwd, …}` → `turn/start`.
- First prompt: `turn/start {threadId, input:[{type:'text', text, text_elements:[]}], summary, effort?}`. The system prompt (today: skill body + handoff contract) is prepended to that text as `<systemPrompt>\n\n---\n\n<userPrompt>` (`prependSystemPrompt`).
- Later messages: `turn/steer {threadId, input, expectedTurnId}` while a turn is active, otherwise a new `turn/start` (`startOrSteerTurn`). Input is always one `text` item (`TurnTextInput`); the adapter sends no `skill`, `mention` or image item today.
- Continue: a new `codex app-server` process, `thread/resume`, then `turn/start`.
- Tool and permission limits: no per-tool allowlist crosses this wire (`codexToolGrantFields` returns `{}` for every grant). When `configRequirements/read` returns `requirements: null`, Squawk sends `sandbox: 'danger-full-access'` (`'workspace-write'` when `CEZ_CODEX_NETWORK=0`); for a managed account it sends no sandbox override. Optional `config` overrides: network off, `features.agent_message_board=false`, Squawk's own MCP server. Approval policy is left to the user's Codex config.
- Non-default account: `CODEX_HOME` selects the folder (`packages/cezar/src/workspace/agent-profiles.ts:40`).
- On this host `configRequirements/read` returned `requirements: null`, so every real turn below ran with `sandbox: 'danger-full-access'`, as a Squawk launch would.

## Method

Three kinds of evidence, all through `codex app-server` on stdio, driven by a Node script:

1. **No-model requests**: `skills/list`, `model/list`, `skills/extraRoots/set`.
2. **Mock provider (no model call)**: `thread/start` with `modelProvider:'probemock'` and `config:{'model_providers.probemock':{base_url:'http://127.0.0.1:<port>/v1', wire_api:'responses', …}}`. A local HTTP server in the probe script recorded the body of each `POST /v1/responses` and answered with a canned reply. This shows exactly which items the app-server puts into the model request for an input form. Request headers were not read. Differences from Squawk's launch: the provider override, `experimentalRawEvents:true` and `ephemeral:true`.
3. **Real model turns** with Squawk's exact `thread/start` and `turn/start` fields, to prove the token arrives and to see the model-choice path.

"Runner injected" below means: the model request (mock) or the thread's rollout file (real turns) holds this extra user message, which the client never sent:

```
<skill>
<name>probe-alpha</name>
<path>/tmp/skill-probe-codex.6zPj5m/repo/.agents/skills/probe-alpha/SKILL.md</path>
---
name: probe-alpha
description: …
---
# probe-alpha
Reply with exactly this token and nothing else: ALPHA-9abaf926. …
</skill>
```

## Results

| Test | Verdict | Evidence |
|---|---|---|
| **L1** list without a model call | **TESTED: yes** | Request `{"id":3,"method":"skills/list","params":{"cwds":["/tmp/skill-probe-codex.6zPj5m/repo"]}}` after `initialize`; no `thread/start`. Response `{data:[{cwd, errors:[{path,message}], skills:[…]}]}`. One entry: `{"name":"probe-alpha","description":"Probe fixture skill …","path":"/tmp/…/repo/.agents/skills/probe-alpha/SKILL.md","scope":"repo","enabled":true,"pluginId":null}`. Optional fields in the schema: `shortDescription`, `interface`, `dependencies`. `scope` is one of `user`, `repo`, `system`, `admin`. Counts for the fixture repo: `repo` 3, `user` 33, `system` 5. Project skills: listed (`repo`). User skills: listed (`user`, paths under `~/.agents/skills`). Plugin skills: listed as `scope:"user"` with a qualified name and a plugin id, e.g. `"name":"<plugin-b>:setup","pluginId":"<plugin-b>@<marketplace>","path":"~/.codex/plugins/cache/<marketplace>/<plugin-b>/<version>/skills/setup/SKILL.md"`. Built-ins: `scope:"system"` under `~/.codex/skills/.system/`. Timing: first call 34 ms, cached 8 ms, `forceReload:true` 19 ms; `initialize` 507 ms under load; whole process (spawn, initialize, list, exit) 0.39 s wall at load 6. |
| L1 folders read | **TESTED** | `.agents/skills` and `.codex/skills` are read; `.claude/skills` is not (the marker skill `probe-dir-claude` never appeared). The project was untrusted; the server said `"Project-local config, hooks, and exec policies are disabled … until the project is trusted, but skills still load."` |
| **L2** cwd sensitivity | **TESTED: yes** | App-server spawned in `/tmp`, one request with four cwds: `repo` → `{"repo":3,"user":33,"system":5}`; `repo/sub/dir` → same 3 repo skills; `/tmp` and the scratch root (no git repo) → `{"user":33,"system":5}`. The request's `cwds` decides, not the spawn cwd. `cwds:[]` falls back to the spawn cwd. A skill in `repo2/sub/.agents/skills` is listed for cwd `repo2/sub/deeper` and not for cwd `repo2` (folders from cwd up to the repo root are scanned). |
| L2 `CODEX_HOME` | **NOT TESTED** | The brief limits this to cwd. `initialize` returns a `codexHome` field, and the list's user and system paths sit under it. |
| **T1** `$probe-alpha` (text) | **TESTED: runner injects** | Mock: text `$probe-alpha` → model request holds the user text plus the `<skill>` message for `probe-alpha`. Real (A1): reply `ALPHA-9abaf926: hello world`; rollout holds `<skill>…probe-alpha`. |
| T1 structured item | **TESTED: runner injects** | Input `[{type:'text',text:'Follow the skill. Arguments: hello world',…},{type:'skill',name:'probe-alpha',path:'<abs>/SKILL.md'}]`. Mock: `<skill>` message present; also with the skill item alone (no text). Real: reply `ALPHA-9abaf926: hello world` in 2.9 s with **no** `commandExecution` item; rollout holds the injection. The item is matched by `path`: right path + wrong name injects; right name + wrong path does not (silent). |
| T1 `/probe-alpha` | **TESTED: no runner trigger** | Mock: text sent verbatim, no `<skill>` message. Real: rollout has no injection; the model chose to run `cat .codex/skills/probe-alpha/SKILL.md` (exit 1), then `cat <abs>/.agents/skills/probe-alpha/SKILL.md`, then answered `ALPHA-9abaf926: hello world`. Model choice. |
| T1 `/skill:probe-alpha` | **TESTED (mock): no runner trigger** | Text sent verbatim, no `<skill>` message. No real turn. |
| T1 other forms | **TESTED (mock)** | `[$probe-alpha](<abs SKILL.md path>) hello` in text: injects. `{type:'mention', name, path:<SKILL.md>}` item: does not inject. Two mentions `$probe-alpha $probe-gamma`: both injected. Squawk-style text `…contract…\n\n---\n\n$probe-alpha hello world`: injects. |
| T1 dedicated request | **DOCS: none** | The 0.164.0 schema (`codex app-server generate-json-schema --experimental`) has `skills/list`, `skills/extraRoots/set`, `skills/config/write`, `plugin/skill/read` (remote plugin skill) and no request that runs a skill. |
| **T2** arguments | **TESTED: yes, as plain text** | There is no argument parsing: the user text stays as sent (`$probe-alpha hello world`) and the body follows it. Real A1: `ALPHA-9abaf926: hello world`. With `/probe-alpha hello world` the model also returned `ALPHA-9abaf926: hello world`, by its own choice. |
| **T3** mid-text | **TESTED** | `Say hi, then run $probe-alpha`: runner injects (mock). `Say hi, then run /probe-alpha`: no injection (mock and real); the model said hi, ran `sed -n '1,240p' <abs>/SKILL.md …` and answered `ALPHA-9abaf926`. Model choice. |
| **T4** unknown name | **TESTED: silent** | `$probe-nope`: `turn/completed` with status `completed`, no error, no warning notification, no `<skill>` message; text reaches the model verbatim. Real reply: "The `probe-nope` skill isn't available in this session." Structured item with an unknown path: same, silent. |
| **T5** prose | **TESTED: model choice** | `Use the probe-gamma skill.`: no injection in the rollout. The model ran `commandExecution` `/bin/bash -lc "sed -n '1,240p' <abs>/.agents/skills/probe-gamma/SKILL.md && …"` and answered `GAMMA-e7d64051`. There is no skill tool: the model reads the file with the shell. The model request lists each skill as `- probe-alpha: <description> (file: r6/probe-alpha/SKILL.md)` with `r6 = <repo>/.agents/skills`. |
| **T6** reference file | **TESTED: yes under `danger-full-access`** | Turn 2 of thread A, `What is the extra token?`: `commandExecution` `sed -n '1,100p' .agents/skills/probe-alpha/references/extra.md` exit 0, reply `BETA-d0ff28d5.` No approval request arrived. The reference file is never injected; the model reads it with the shell. |
| **T7** later message | **TESTED: yes on `turn/start`** | Third `turn/start` of thread A with `$probe-late3`: reply `LATE3-71c0de42`, rollout injections `["probe-alpha","probe-late3"]`. Mock: turn 2 `$probe-gamma hello` on the same thread is injected. |
| T7 after resume | **TESTED: yes** | New `codex app-server` process, `thread/resume {threadId, model, cwd, sandbox}` (391 ms), `turn/start` `$probe-gamma hello`: reply `GAMMA-e7d64051: hello` in 2.7 s, no `commandExecution`; rollout injections `["probe-alpha","probe-late3","probe-gamma"]`. |
| T7 `turn/steer` | **TESTED (mock): NOT expanded** | `turn/steer` during a slow model request with text `STEERED $probe-gamma hello`: accepted (`{"turnId":…}`); the next model request holds `SLOWMOCK first message` and `STEERED $probe-gamma hello` and no `<skill>` message. Same with a structured `skill` item in the steer input. |
| **T8** skill added after start | **TESTED: yes** | Live thread: folder written after two turns; a `skills/changed` notification arrived at once; `skills/list` without `forceReload` listed it; the next `turn/start` injected it (mock) and returned its token (real A3). After resume: `$probe-late` injected. A folder written after the resume and mentioned immediately: injected. |

### Name rules, duplicates, plugin names (TESTED, list and mock)

- Name charset is not enforced. `name: Probe Upper Case` and `name: "probe:colon"` are listed as written.
- Limit: `"invalid name: exceeds maximum length of 64 characters"` (the skill is dropped and reported in `errors`).
- The name need not match the folder: folder `mismatch-folder` with `name: probe-other-name` is listed and triggered as `$probe-other-name`; `$mismatch-folder` does nothing. No `name` key: the folder name is used.
- `description` is required: `"missing field `description`"`. No frontmatter: `"missing YAML frontmatter delimited by ---"`. Bad YAML: `"invalid YAML: …"`. All are per-skill entries in `errors`; the other skills still load.
- A flat `.agents/skills/probe-flat.md` is not listed. A nested `.agents/skills/group/probe-nested/SKILL.md` is listed.
- A skill folder that is a symlink to outside the repo is listed with the resolved target path, `scope:"repo"`, and `$probe-linked` injects it.
- Duplicate name in `.agents/skills` and `.codex/skills`: `skills/list` returns both entries with the same `name`. Text `$probe-dup` injects **nothing**, silently. The structured item with the wanted copy's `path` injects that copy.
- `$` mentions are case-sensitive (`$PROBE-NESTED` does nothing). A name with spaces cannot be mentioned with `$`. Trailing punctuation is fine (`run $probe-nested.` injects).
- Plugin skills: listed as `<plugin>:<skill>` with `pluginId`. `$<plugin-b>:setup` injects the plugin's skill; the bare `$setup` does not.

### `codex exec` comparison (TESTED with the mock provider, no model call)

`codex exec --json --ephemeral --skip-git-repo-check -C <repo> -m gpt-5.6-luna -c model_provider="probemock" -c model_providers.probemock={…} '<prompt>'`: `$probe-alpha hello world` → the model request holds the `<skill>` message; `/probe-alpha hello world` → it does not. Same as app-server text input. `exec` has no way to send a structured item and no list command.

## Surprises

1. **`turn/steer` does not expand skills.** Squawk sends a message that arrives during a live turn with `turn/steer`. Neither `$name` nor a structured item is expanded there; the text reaches the model as written.
2. **Injected, and the model still reads the file.** In real turn A1 (`$probe-alpha hello world`) the app-server injected the body, and `gpt-5.6-luna` also ran `sed -n '1,200p' .agents/skills/probe-alpha/SKILL.md` before answering. The same happened in A3. The structured-item turn and the post-resume turn answered with no command. So "no shell read in the stream" is not a reliable sign of injection, and a shell read is not proof of its absence.
3. **The normal event stream does not show the injection.** With Squawk's flags the turn's items are `userMessage` (the client's own items echoed back, including a `skill` item), `reasoning`, `agentMessage`, `commandExecution`. The `<skill>` message appears only as `rawResponseItem/completed` when `thread/start` sets `experimentalRawEvents:true` (the schema marks this "internal use only"), and in the rollout file.
4. **A failed trigger is silent.** Unknown name, wrong path, ambiguous (duplicate) name: no error, no warning, the turn completes. `skills/list` before the turn is the only way to know a trigger will resolve.
5. **A duplicate name disables the `$name` form.** Only the structured item with a `path` still works.
6. **`/name` often works by model choice.** `/probe-alpha` returned the token in both real turns, because the model went and read the file. It is not a runner trigger.
7. **Session roots, re-test of the October lead (mock):**
   - `skills/extraRoots/set {extraRoots:[<dir>]}`: answers `{}`; the skill is then in `skills/list` (as `scope:"user"`) and both `$probe-extra` and the structured item inject it. It holds for that app-server process only (a new process no longer lists it) and the top-level `*.toml`/`*.json` files in `~/.codex` kept their size and mtime.
   - `thread/start.selectedCapabilityRoots:[{id, location:{type:'environment', environmentId:'local', path}}]`: the skill is in the model's catalog and `$probe-cap` injects it with the path `skill://<rootId>/<abs path>/SKILL.md`. `skills/list` does **not** list it. A structured item with the plain file path does **not** inject (the October finding still holds); a structured item with the `skill://<rootId>/…` path does.
8. **Untrusted project:** project skills load although project config, hooks and exec policies are disabled.
9. **An earlier injection stays in history.** Later model requests of the thread, also after resume, carry the old `<skill>` messages again as history (seen in the mock requests). Whether an edited SKILL.md replaces an older injected copy was not tested.

## Not tested, and why

- **L2 with `CODEX_HOME`**: the brief limits L2 to cwd. Whether `~/.agents/skills` follows `CODEX_HOME` or `HOME` is open.
- **`skills/config/write` and the `enabled:false` state**: the request writes user config, which the ground rules forbid. Every listed skill had `enabled:true`.
- **T6 under `workspace-write` or a managed profile**: only Squawk's unmanaged default (`danger-full-access`) was run. On this host the server also warns "Codex's Linux sandbox uses bubblewrap and needs access to create user namespaces", so a sandboxed run would not have been representative. Reads of a user-level or plugin skill's reference files under a restricted sandbox are open.
- **`turn/steer` with a real model**: tested with the mock only; a real model may still read the file by its own choice.
- **`/skill:probe-alpha` and the `mention` item with a real model**: mock only (no injection).
- **Real-model turns for duplicate names, plugin-qualified names and extra or capability roots**: mock only, to stay inside the turn budget.
- **`admin` scope and managed (enterprise) skills**: none on this account.
- **Interactive TUI behaviour** (`/skills`, the `$` picker): out of scope, Squawk does not use it.

## Housekeeping

- Sessions Codex wrote in its home by itself: six real threads (`01a1e419-e556-…`, `01a1e41a-508f-…`, `01a1e41a-7e11-…`, `01a1e41a-8976-…`, `01a1e41a-cc4b-…`, `01a1e41a-d9f7-…`) and one mock thread (`01a1e418-a8b2-…`). All other mock threads were `ephemeral`. The probe scripts wrote nothing under `~/.codex` or `~/.agents`; Codex's own writes there (sessions, its logs and state) were not audited beyond the check in Surprise 7.
- One runner process at a time; every app-server and `codex exec` PID was recorded and seen to exit (code 0). No process with a cwd in the scratch root is left.
- No Squawk, hsq or cez command was used; no subagent; the repo worktree is unchanged.

## Open checks, round 2 (2026-11-16)

Same runner (`codex-cli 0.164.0`), same transport (`codex app-server` on stdio). Scratch root `/tmp/skill-probe-codex.hx7pVt` (a git repo with `probe-alpha` and `probe-gamma` in `.agents/skills`, and a scratch Codex home `home2/`). Two real model turns (`gpt-5.6-luna`, effort `low`); everything else used no model call. Host load average was about 65 during the real turns.

| Check | Verdict |
|---|---|
| A: does the list follow a non-default account home? | **Partly.** `CODEX_HOME` moves the home's own skills, the plugin skills and the built-in skills. Skills in `~/.agents/skills` stay in the list under every `CODEX_HOME`. The list works in a home with no login. |
| B: `turn/steer` with a real model | **Confirmed: no expansion.** Neither `$probe-alpha` nor a structured `skill` item in a steer injects the skill body. `$probe-alpha` still returned the token because the model read the file itself; the structured item returned no token. |
| B: what the protocol offers instead | Four routes expand the skill (all TESTED with the mock provider); `turn/start` during an active turn does not. See the table below. |

### Check A: the account home

**How Squawk selects the account (DOCS, source).**

- Variable: `CODEX_HOME`, selected "by folder" (`ACCOUNT_LAYOUT.codex`, `packages/cezar/src/core/agent-profiles.ts:40`).
- `resolveProfileEnvForRoot` (`packages/cezar/src/workspace/agent-profiles.ts:118`) returns `{ CODEX_HOME: <account folder> }` for a named account and `{}` for the default account. The runner merges it over the child env (`buildCodexAppServerEnv`).
- What Squawk puts in that home: nothing found. It reads two names there as an advisory "looks like a Codex home" check (`auth.json`, `config.toml`; `PROFILE_DIR_MARKERS.codex`) and reads `auth.json` to show the account identity (`agent-config/account-identity.ts`). The login command and the status probe run the Codex CLI with the same variable (`core/provider-auth.ts`, `loginCommand` and `probe`); the CLI writes the home.

**Test (TESTED, no model call).** Scratch home `home2/` held only `skills/probe-homeskill/SKILL.md`; no credential file was copied or linked. Requests: `initialize`, `account/read {}`, `skills/list {cwds:[<scratch repo>], forceReload:true}`, `plugin/list`, `model/list`, once with the default env and once with `CODEX_HOME=<scratch>/home2`.

| Source of the listed skill | Default home | `CODEX_HOME` = scratch home |
|---|---|---|
| Scratch repo `.agents/skills` (`scope:"repo"`) | 2 | 2 |
| Scratch home `skills/` (`scope:"user"`) | n/a | 1 (`probe-homeskill`) |
| `~/.agents/skills` (`scope:"user"`; one of them through a symlink to another folder under `~`) | 5 | **5** |
| `~/.codex/plugins/cache` (`scope:"user"`, with `pluginId`) | 28 skills from 3 plugins | **0** |
| Built-in skills (`scope:"system"`) | 5, under `~/.codex/skills/.system` | 5, under `<scratch home>/skills/.system` |
| Total | 40 | 13 |

Excerpts:

- Default: `initialize ok … codexHome=~/.codex`, `skills/list ok 110 ms errors=0 total=40`, `plugin/list: marketplaces=3 plugins=59 installed=3`.
- Scratch: `initialize ok 486 ms codexHome=/tmp/skill-probe-codex.hx7pVt/home2`, `skills/list ok 18 ms errors=0 total=13`, `{"name":"probe-homeskill","scope":"user","path":"/tmp/skill-probe-codex.hx7pVt/home2/skills/probe-homeskill/SKILL.md"}`, `plugin/list: marketplaces=0 plugins=0 installed=0`.

Answers to the brief's questions:

- **Does the scratch home's user skill appear?** Yes, from `$CODEX_HOME/skills/<name>/SKILL.md`, `scope:"user"`.
- **Do the real home's user skills and plugins disappear?** The plugin skills (28) and the plugin list disappear. The real home has no skill of its own in `~/.codex/skills` apart from the built-ins, so there was nothing else to disappear.
- **Which real-home sources still appear?** `~/.agents/skills`: all 5 skills, unchanged. That folder follows `HOME`, not `CODEX_HOME`. The response gives both kinds `scope:"user"`; only `path` tells them apart.
- **Does the list work without a login in that home?** Yes. `initialize`, `skills/list`, `plugin/list` and `model/list` all answered with no error; `account/read` returned `account: null`. (It also returned `account: null` in the default home on this host.)
- **Side effect:** the list-only run made Codex write into the scratch home: `skills/.system/` (the 5 built-ins), `installation_id`, five `*.sqlite` state files with their `-shm`/`-wal` files, and `.tmp/` with a `plugins.sync.lock` and a `git-*` folder.

NOT TESTED: a home that has a login but different plugins; whether `.tmp/git-*` means Codex starts fetching a plugin marketplace into a new home.

### Check B: `turn/steer` with a real model

Schema (DOCS): `TurnSteerParams.input` is an array of the same `UserInput` union as `turn/start`: `["text","image","localImage","audio","localAudio","skill","mention"]`. So `turn/steer` accepts a `skill` item. Required fields: `threadId`, `expectedTurnId`, `input`.

Setup for both turns (Squawk's fields): `thread/start {model, cwd, sandbox:'danger-full-access'}`, then `turn/start` with the text "Run the shell command `sleep 20` now and wait for it. When it has finished, reply with the single word DONE.", `effort:'low'`. Three seconds after the `commandExecution` item for `sleep 20` started, the probe sent `turn/steer`. Evidence for "injected" is the thread's rollout file (user-role items and a search for the `<skill>` wrapper).

| Steer input | Steer result | Rollout | Model's answer | Verdict |
|---|---|---|---|---|
| `[{type:'text', text:'$probe-alpha steer-args'}]` | `{"turnId":"…"}` at +8.5 s; echoed as a `userMessage` item while `sleep` was still running | User items: the opening prompt and `$probe-alpha steer-args`. `<skill>` injection: **false** | After `sleep 20` (exit 0) the model ran `sed -n '1,240p' <repo>/.agents/skills/probe-alpha/SKILL.md` and answered `ALPHA-401a972d: steer-args` | **TESTED: not expanded.** The token arrived by model choice. |
| `[{type:'text', text:'Follow the attached skill. Arguments: steer-args'}, {type:'skill', name:'probe-alpha', path:'<repo>/.agents/skills/probe-alpha/SKILL.md'}]` | `{"turnId":"…"}` at +7.5 s; the `userMessage` item echoes both items | User items: the opening prompt and the steer text. `<skill>` injection: **false** | The model ran `rg --files -g 'SKILL.md' -g 'AGENTS.md' -g '*skill*' .` (exit 1) and answered `DONE`. No token | **TESTED: accepted, not expanded.** The skill item is dropped without an error. |

Both turns ended as one `turn/completed` with status `completed` under the turn id that `turn/start` returned. No approval request arrived.

### What the protocol offers for a mid-turn skill message

All TESTED with the mock provider (a local `POST /v1/responses` recorder, no model call), text `$probe-gamma …` sent while or after a 5-second model request. "Expanded" means the next model request holds the `<skill>` message for `probe-gamma`.

| Route | Result | Expanded |
|---|---|---|
| `turn/steer` during the active turn | Round 1 (mock) and Check B (real) | No |
| `turn/start` during the active turn | Returns the **active** turn's id with status `inProgress`; the text joins the running turn; one `turn/completed` in total. Model request: `["SLOWMOCK first message","$probe-gamma second-start"]` | **No** |
| `turn/interrupt {threadId, turnId}`, wait for `turn/completed` (status `interrupted`), then `turn/start` | Second turn completes. Model request: `["<turn_aborted> The user interrupted the previous turn on purpose…","$probe-gamma after-interrupt","<skill> probe-gamma"]`. The interrupt here landed before the first model request was sent, and the first turn's own text was not in the next request | Yes |
| Wait for `turn/completed`, then `turn/start` (queue in the client) | Model request: `["SLOWMOCK first message","$probe-gamma after-completed","<skill> probe-gamma"]` | Yes |
| `thread/queue/add {threadId, clientUserMessageId, input}` during the active turn (queue in the server) | Returns `{"queuedSubmission":{"id":…,"input":[…],"clientUserMessageId":"probe-q-1"}}`; three `thread/queue/changed` notifications; when the active turn completed, a second turn ran by itself (no `thread/queue/start` sent); the queue was empty afterwards. Model request: `["SLOWMOCK first message","$probe-gamma queued","<skill> probe-gamma"]`. On an `ephemeral` thread the request fails: `"ephemeral thread does not support queued submissions: <threadId>"` | Yes |

DOCS only (schema, not run):

- `thread/queue/list`, `/delete`, `/reorder`, `/update`, `/start {threadId, queuedSubmissionId?}` manage the server queue.
- `thread/inject_items {threadId, items}` appends "Raw Responses API items to append to the thread's model-visible history". The client would have to supply the skill body itself.

NOT TESTED: the server queue and the interrupt route with a real model; a structured `skill` item through `thread/queue/add`; how a queued submission behaves across `thread/resume`.

### Housekeeping, round 2

- Sessions Codex wrote in its home by itself: two real threads (the steer turns) and one mock thread (the non-ephemeral queue test; an earlier attempt of that test was cut off by a session restart and may have left one more). The other mock threads were `ephemeral`.
- One runner process at a time. Every app-server PID was recorded and seen to exit with code 0, except the run cut off by the restart; after it, no process with a cwd inside the scratch root existed. The scratch root is removed.
- No Squawk, hsq, cez or squeal command was run; no subagent; this report is the only file this probe changed in the worktree, and it is not committed.
