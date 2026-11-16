# pi: native skill listing and native skill trigger

- Runner: pi coding agent **1.4.0** (`pi --version`), package `@earendil-works/pi-coding-agent` under the nvm global
  `node_modules`; `~/.local/bin/pi` is a launcher script that execs it.
- Probe date: 2026-11-16. Model: `zai/glm-5.3-flash`. Model turns used: 12 of 12.
- Markers: **TESTED** (ran here), **DOCS** (pi docs, `--help` or installed source), **NOT TESTED**.
- `<S>` below is the scratch repo `/tmp/skill-probe-pi.1wnBKT` (removed after the probe).
- `<pkg>` is the installed package folder; `<X>` is `packages/cezar/scripts` in the worktree.

## Step 0: how Squawk drives pi

Source: `packages/cezar/src/core/pi-runner.ts` (`buildPiArgs`, `piToolArgs`, `startSession`), `pi-rpc-wire.ts`.

- Transport: one long-lived `pi --mode rpc` child per session, JSONL commands on stdin, JSONL records on stdout.
- argv, default tool list:
  `pi --mode rpc --extension <X>/pi-retry-degraded-service.mjs --extension <X>/pi-project-skills.mjs`
  `[--extension <X>/pi-ci-wait.mjs] [--session-id <id> | --session <id>] [--append-system-prompt <text>]`
  `[--model provider/model] [--thinking <level>] --no-builtin-tools --extension <X>/pi-default-tools.mjs`
  `--cezar-builtin-tools read,edit,write,grep,find,bash`.
  A narrowed tool list sends `--tools a,b,c` instead; a list that maps to nothing sends `--no-tools`.
- First writes on stdin: `{"id":"cezar-state","type":"get_state"}`, `{"type":"set_steering_mode","mode":"all"}`,
  then `{"type":"prompt","message":<userPrompt>[,"images":[...]]}`.
- Later messages: the same `prompt` command; when a turn is running it adds `"streamingBehavior":"steer"`.
- Resume (Continue): a new process with `--session <id>` in place of `--session-id <id>`.
- Non-default account: Squawk sets `PI_CODING_AGENT_DIR` (`agent-profiles.ts` line 42).
- Squawk sends no `get_commands` today and no `/skill:` text (grep over `packages/cezar/src` and `scripts`: no hit).
- `pi-project-skills.mjs` matters for skills: pi loads `<cwd>/.pi/skills` and `.agents/skills` only for a trusted
  folder, and RPC mode cannot ask. The extension offers those folders through `resources_discover` when the
  folder is untrusted.

All probes ran through this transport with the argv above (without `pi-ci-wait.mjs`, which needs Squawk's
socket), `TMPDIR=/tmp`, cwd `<S>`.

## Fixture

| Folder | Skills |
|---|---|
| `<S>/.pi/skills` | `probe-alpha` (ALPHA-b7f542f2, extra BETA-4ce87729), `probe-gamma` (GAMMA-5eefa2da) |
| `<S>/.agents/skills` | `probe-alpha` (ALPHA-0dd16b14, same name on purpose), `probe-epsilon` (EPSILON-4a0f3082) |
| `<S>/.claude/skills` | `probe-delta` (negative control) |

Folders pi 1.4.0 reads (DOCS: `<pkg>/dist/core/package-manager.js` lines 2011-2064, `docs/skills.md`):
`<agentDir>/skills` (user; `agentDir` = `$PI_CODING_AGENT_DIR` or `~/.pi/agent`), `~/.agents/skills` (user, from
`$HOME`), `<cwd>/.pi/skills` (project, cwd only, no ancestors), `.agents/skills` in cwd and every ancestor up to
the git root (project), plus `skills` paths in settings, pi packages, `--skill <path>` and extension
`resources_discover`. `.claude/skills` is not read (TESTED: `probe-delta` never listed).

## Results

| # | Verdict | Evidence |
|---|---|---|
| L1 | **Yes.** RPC `get_commands` lists skills with no model call. TESTED | Request: `{"id":"c","type":"get_commands"}` to `pi --mode rpc <Squawk flags> --no-session`, cwd `<S>`. Response `data.commands[]`, 34 entries: 32 with `source:"skill"`, 2 with `source:"extension"` (`llama`, `mcp`). Entry shape: `{"name":"skill:probe-alpha","description":"...","source":"skill","sourceInfo":{"path":"<S>/.pi/skills/probe-alpha/SKILL.md","source":"extension:pi-project-skills.mjs","scope":"temporary","origin":"top-level","baseDir":"..."}}`. Stream held only `response` records, no `agent_start`. Wall time for spawn + `get_state` + `get_commands` + exit: 0.5 to 1.1 s over 10 runs at load 25 to 37. |
| L1 scopes | Project, user and extension/package skills all listed. TESTED | User: `["skill:<user-skill>","user","auto",".../.agents/skills/<user-skill>/SKILL.md"]` (6). Project through Squawk's extension: scope `temporary`, source `extension:pi-project-skills.mjs` (3). Skills another extension offers (a package installed on the host): `["skill:<skill>","temporary","extension:<package>",".../plugins/<plugin>/skills/<skill>/SKILL.md"]` (23), bare names. With `--approve` in place of the extension the project ones read `scope:"project", source:"auto"`. |
| L1 session | Needs a pi process, not a saved session. TESTED | Ran with `--no-session`. There is no `pi` subcommand or flag that prints skills: `pi list` is "List installed packages from user and project settings", `pi config` is a TUI (DOCS: `pi --help`, `pi list --help`). |
| L1 trust | Without Squawk's extension and without `--approve`, project skills are absent. TESTED | `pi --mode rpc --no-session --model ...` in `<S>`: 29 skills, no `probe-*`. Same with `--approve`: 32, the three `probe-*` present. DOCS: `docs/security.md` "Print, JSON, and RPC modes cannot show the built-in trust prompt". |
| L2 cwd | List depends on cwd. TESTED | cwd `<S>/sub`: `probe-alpha` now from `.agents/skills` (ancestor walk), `probe-epsilon`; `.pi/skills/probe-gamma` gone, because `.pi/skills` is read from cwd only. Same result with Squawk's extension and with `--approve`. cwd outside the repo: no `probe-*`. |
| L2 home var | `PI_CODING_AGENT_DIR` moves `<agentDir>/skills`, settings (packages) and `trust.json`; `~/.agents/skills` follows `$HOME`. DOCS | `<pkg>/dist/config.js` `getAgentDir()` lines 491-497; `trust-manager.js` line 174; `package-manager.js` line 2023. NOT TESTED by brief. |
| T1 `/skill:probe-alpha` | **Works; the runner loads the body.** TESTED | Sent `{"type":"prompt","message":"/skill:probe-alpha"}`. Ack `{"command":"prompt","success":true,"data":{"disposition":"started"}}`. User `message_end` content: `<skill name="probe-alpha" location="<S>/.pi/skills/probe-alpha/SKILL.md">\nReferences are relative to <S>/.pi/skills/probe-alpha.\n\n# probe-alpha\n\nReply with exactly this token ... ALPHA-b7f542f2 ...</skill>`. Assistant: `ALPHA-b7f542f2`. No tool call in the turn. |
| T1 `/probe-alpha` | No runner expansion; the model chose to read the file. TESTED | User `message_end` content: `/probe-alpha`. Assistant called `read` with `path:<S>/.pi/skills/probe-alpha/SKILL.md`, then answered `ALPHA-b7f542f2`. |
| T1 `$probe-alpha` | No runner expansion; model choice. TESTED | User content: `$probe-alpha`; `read` on the same SKILL.md; `ALPHA-b7f542f2`. |
| T1 structured item / dedicated request | None exists. DOCS | `rpc-mode.js` command list has no skill command; `prompt`, `steer`, `follow_up` take text and images only. Expansion is text-prefix based: `agent-session.js` `_expandSkillCommand`, `if (!text.startsWith("/skill:")) return text`. |
| T2 arguments | Passed; appended after the block. TESTED | Sent `/skill:probe-alpha hello world`. User content ends `...</skill>\n\nhello world`. Assistant: `ALPHA-b7f542f2: hello world`. |
| T3 mid-text | No runner expansion; model choice. TESTED | Sent `Say hi, then run /skill:probe-alpha`. User content unchanged. Assistant: "Hi there! ... Let me load the probe-alpha skill now.", `read` on SKILL.md, then `ALPHA-b7f542f2`. |
| T4 unknown name | Silent pass-through as plain text; no error record. TESTED | Sent `/skill:probe-nope`. Ack `success:true, disposition:"started"`. User content: `/skill:probe-nope`. No `extension_error`, stderr empty apart from the new-session warning. Assistant: "There's no skill named `probe-nope` in this session. The available probe fixture skills are: ...". `/probe-nope` takes the same plain-text path as `/probe-alpha` (DOCS: source above), NOT TESTED with a turn. |
| T5 prose | Model choice through `read`. TESTED | Sent `Use the probe-gamma skill.` Assistant called `read` with `path:<S>/.pi/skills/probe-gamma/SKILL.md`, then `GAMMA-5eefa2da`. pi has no skill tool; the system prompt section `skills` said "Use the read tool to load a skill's file when the task matches its description." with 32 `<skill>` entries (name, description, location). |
| T6 reference file | Readable with Squawk's default launch. TESTED | Third turn of the T1 session: `Now give me the extra token.` Assistant called `read` with `path:<S>/.pi/skills/probe-alpha/references/extra.md`; tool result `The extra token is BETA-4ce87729.`; answer `BETA-4ce87729`. pi has no permission prompt (DOCS: `docs/security.md`), so the only gate is whether `read` or `bash` is an active tool. With a narrowed `--tools` that names neither, pi drops the skills section from the system prompt (DOCS: `system-prompt.js` lines 101-108); `/skill:` expansion does not depend on tools (DOCS: source). NOT TESTED with a narrowed list. |
| T7 second turn | Works. TESTED | Turn 2 of the same process: `/skill:probe-alpha hello world`, expanded as in T2. |
| T7 as a steer | Works. TESTED | While `bash sleep 6` ran, sent `{"type":"prompt","message":"/skill:probe-gamma steered","streamingBehavior":"steer"}`. Ack `disposition:"queued"`. After the tool result, user content `<skill name="probe-gamma" ...>...</skill>\n\nsteered`; assistant `GAMMA-5eefa2da: steered`. |
| T7 resume | Works. TESTED | New process with `--session <id>`: `get_state` returned the same `sessionId`, `messageCount:10`. `/skill:probe-late` expanded to a `<skill name="probe-late" ...>` block; assistant `LATE-5c1d9e07`. |
| T8 folder added later | Same process: not seen. New process (resume): seen. TESTED (list); trigger after resume TESTED | `.pi/skills/probe-late` created after turn 3: `get_commands` in that process still gave `probe-alpha, probe-gamma, probe-epsilon`. A second check waited 4 s after creating `probe-late2`: still absent. The resumed process listed `probe-late`, and its first turn carried a system record with only the changed sections `["mcp_servers","skills"]`. RPC has no reload command (DOCS: `rpc-mode.js` command list; `docs/skills.md` names the TUI's `/reload`). The same-process trigger was not run with a turn; expansion reads the same list as `get_commands` (DOCS: source). |

### Name rules and collisions

| Case | Result |
|---|---|
| Folder `dir-mismatch`, `name: probe-renamed` | Listed as `skill:probe-renamed`. TESTED. DOCS: "Pi neither requires nor warns when the declared name differs from the parent directory." |
| `name: "Probe_Bad:X"` | Listed as `skill:Probe_Bad:X`. TESTED. The charset rule (`^[a-z0-9-]+$`, 64 chars, no leading, trailing or double hyphen) only produces a warning (DOCS: `skills.js` `validateName`); nothing appeared on RPC stdout or stderr. |
| No `description` | Not listed, no record on stdout or stderr. TESTED |
| No `name` | Folder name used (`skill:probe-noname`). TESTED |
| Loose `.pi/skills/probe-loose.md` with a description | Listed as `skill:skills` (parent folder name). TESTED |
| Nested `.pi/skills/group/probe-nested/SKILL.md` | Listed. TESTED |
| `disable-model-invocation: true` | Listed by `get_commands`. TESTED. Left out of the system prompt, `/skill:` still works (DOCS: `skills.js` `formatSkillsForPrompt`, `docs/skills.md`); NOT TESTED with a turn. |
| Same name in `.pi/skills` and `.agents/skills` | One entry; `.pi/skills` wins, with Squawk's extension and with `--approve`. TESTED (list path, and T1 returned ALPHA-b7f542f2, not ALPHA-0dd16b14). The loser is not reported over RPC. DOCS: "Name collisions keep the first discovered skill and produce a warning." |
| User skill and project skill with one name | NOT TESTED (user homes are read-only here). DOCS: comment in `pi-project-skills.mjs`: under the extension the user's copy wins; in a trusted session the project's wins. |
| Plugin-qualified names | pi has none. Package and extension skills get bare names (TESTED: `skill:<skill>` from `plugins/<plugin>/...`); `sourceInfo` carries the origin (`source`, `scope`, `origin`, `baseDir`). A `:` in a name is accepted as plain text (`skill:Probe_Bad:X`). |

### Flags that change the list (no model call)

| Flag | Result |
|---|---|
| `--skill <dir or file>` | Adds a skill for this process only, without trust: `["skill:probe-flag","temporary","local",".../extra/probe-flag/SKILL.md"]`. TESTED |
| `--approve` | Loads project `.pi/skills` and `.agents/skills` natively with `scope:"project"`. TESTED |
| `--no-skills` with Squawk's flags | The 6 user skills disappear; skills offered by extensions stay (Squawk's project skills and the 23 package ones). TESTED |

### `-p` (print) mode

Same expansion. TESTED: `pi -p --mode json --extension <X>/pi-project-skills.mjs --model zai/glm-5.3-flash --no-session "/skill:probe-epsilon printed"`
gave user content `<skill name="probe-epsilon" location="<S>/.agents/skills/probe-epsilon/SKILL.md">...</skill>\n\nprinted`
and assistant `EPSILON-4a0f3082: printed`.

## Surprises

- The trigger is pure text substitution into the user message. The stream reports the expanded `<skill ...>`
  block as the user's message, not the `/skill:name` text that was sent (the session file was not read).
- A wrong name is not an error: the ack is `success:true, disposition:"started"` and the model gets the literal text.
  The only way to know beforehand is `get_commands`.
- Only a message that starts with `/skill:` expands. `/probe-alpha`, `$probe-alpha` and a mid-text `/skill:` all
  reached the model as written; the model loaded the skill with `read` in each case, which is model choice.
- Squawk's default launch (`--no-builtin-tools` plus the default-tools extension) keeps the skills section in the
  system prompt and names the `read` tool; the October lead that the default tool flags might hide skill loading
  does not hold on 1.4.0 with the current adapter.
- Project skills reach an RPC session only because of Squawk's `pi-project-skills.mjs`; plain pi in an untrusted
  folder lists none, with no warning. Through the extension their scope reads `temporary`, not `project`, and
  `baseDir` is the extension's folder.
- `.pi/skills` is read from cwd only, while `.agents/skills` is read from cwd and its ancestors up to the git root.
  From `<S>/sub` the name `probe-alpha` resolved to a different file with a different token.
- Invalid names, missing descriptions and collisions produce nothing on the RPC stream or stderr.
- pi emits a `message_end` with `role:"system"` and a `sections` object at the start of a run (all sections on a
  new session, only changed ones later), so the skill list the model was given is visible in the stream.
- `--no-skills` does not remove skills that extensions offer.
- The host's package skills arrive through an extension (`extension:<package>`) and are listed too, so the
  list is not limited to skill folders.

## Not tested, and why

- `PI_CODING_AGENT_DIR` effect on the list: the brief limits L2 to cwd.
- User-level versus project-level name collision: needs a write to a user home, which is forbidden.
- `/probe-nope` (unknown plain slash) with a model turn, `disable-model-invocation` with a turn, a narrowed
  `--tools` list without `read`/`bash`, and a same-process trigger of a late-added skill: turn budget spent; each
  is covered by source reading and marked DOCS above.
- `follow_up` and `steer` commands as separate RPC commands: Squawk does not send them (it uses `prompt` with
  `streamingBehavior`); DOCS say they expand `/skill:` the same way (`docs/rpc-commands.md`).
- `pi-ci-wait.mjs` loaded alongside: it needs Squawk's tool socket.
- pi packages installed at project level, and `get_commands` without a configured model or with failed auth.

## Open checks, round 2 (2026-11-16)

pi 1.4.0, same transport and flags as round 1 (`pi --mode rpc` plus Squawk's extensions and default tool flags).
`<S>` is a new scratch repo and `<H>` a scratch pi home, both directly under `/tmp` and removed afterwards.
Model turns used: 2 of 4 (`zai/glm-5.3-flash`). Everything else ran with no model call. For the stream checks
that need a prompt but no model, `<H>/models.json` held one provider whose `baseUrl` was `http://127.0.0.1:9/v1`
(connection refused), so pi emitted the user message and then `stopReason:"error", errorMessage:"Connection error."`.

Fixture: `<S>/.pi/skills/probe-alpha`, `<S>/.pi/skills/probe-shared`, and two project skills named like two of
the user's own `~/.agents/skills` skills (`<U1>` in `<S>/.pi/skills`, `<U2>` in `<S>/.agents/skills`);
`<H>/skills/probe-homeskill` and `<H>/skills/probe-shared`. No credential file was copied or linked into `<H>`.

### Check A: does the list follow a non-default account home?

- Variable: `PI_CODING_AGENT_DIR`, set to the account folder. DOCS: `packages/cezar/src/core/agent-profiles.ts`
  line 42 (`pi: { select: { envVar: 'PI_CODING_AGENT_DIR', by: 'folder' }, configSubdir: null, ... }`) and
  `profileEnv()`; applied by `workspace/agent-profiles.ts` only for a named account (the default account adds
  nothing to the env).
- What Squawk puts in that home: nothing. It stores the folder path in its own `~/.cezar/agent-accounts.json`,
  and pi creates the content on login. DOCS: `agent-profiles.ts` comment "add the profile → Connect → the CLI
  creates the dir on login"; the markers Squawk looks for are `auth.json`, `settings.json`, `models.json`,
  `sessions` (`PROFILE_DIR_MARKERS.pi`).

| Question | Verdict | Evidence |
|---|---|---|
| Scratch home's user skill appears | Yes. TESTED | `PI_CODING_AGENT_DIR=<H> pi --mode rpc <Squawk flags> --no-session`, cwd `<S>`, `{"type":"get_commands"}` → `["skill:probe-homeskill","user","auto","<H>/skills/probe-homeskill/SKILL.md"]`. |
| Real home's package and extension skills disappear | Yes. TESTED | Default home: 31 skills, 23 of them under `~/.pi/agent/` (a package from that home's `settings.json`, offered through its extension). With `<H>`: 9 skills, 0 under `~/.pi/`. The real home has no `~/.pi/agent/skills` folder, so that source could not be compared. |
| Real-home sources that still appear | `~/.agents/skills`: all 6 still listed. TESTED | Same run: 6 entries with `scope:"user"` and paths under `~/.agents/skills/`. pi reads that folder from `$HOME`, not from the agent dir (DOCS: `package-manager.js` line 2023). The two built-in extension commands (`llama`, `mcp`, source `builtin`) also stay. |
| Works without a login in that home | Yes. TESTED | `<H>` held only `skills/`. `get_state` and `get_commands` both `success:true`, stderr empty, 1.2 to 1.6 s. With `--model zai/glm-5.3-flash` `get_state` named that model; without `--model` it reported `unknown/unknown`; the list was the same 9 skills. pi created `auth.json` and `models-store.json` (2 bytes each) in `<H>` by itself. |
| Project skills under the scratch home | Listed through Squawk's extension as before. TESTED | `["skill:probe-alpha","temporary","extension:pi-project-skills.mjs","<S>/.pi/skills/probe-alpha/SKILL.md"]`. `trust.json` lives in the agent dir (DOCS: `trust-manager.js` line 174), so a new home has no saved trust decisions. |

### Check B: opening context and trigger in one message

| Order | Verdict | Evidence |
|---|---|---|
| (1) `/skill:probe-alpha hello`, blank line, context paragraph | Expands; the arguments are everything after the first space, context included; the model sees the token. TESTED (2 model turns, default home) | Sent `{"type":"prompt","message":"/skill:probe-alpha hello\n\nContext from an earlier task: the context token is CTX-82907fcf. If asked for the context token, answer with it."}`. User `message_end`: `<skill name="probe-alpha" location="<S>/.pi/skills/probe-alpha/SKILL.md">...</skill>\n\nhello\n\nContext from an earlier task: the context token is CTX-82907fcf. ...`. Assistant: `ALPHA-3280589c` (it did not append `hello`, although the skill says to append arguments). Next turn `What is the context token?` → `CTX-82907fcf`. |
| (1b) `/skill:probe-alpha`, blank line, context (no argument on the first line) | **Not expanded.** TESTED (no model call) | Sent `"/skill:probe-alpha\n\nContext from an earlier task: ..."`. User `message_end` content is the text as sent. Cause (DOCS: `agent-session.js` `_expandSkillCommand`): the name runs to the first space, so pi looks up `probe-alpha\n\nContext`, finds no skill and passes the text through. Ack was still `success:true, disposition:"started"`. |
| (2) context first, trigger after it | Not expanded. TESTED (no model call) | Sent `"Context from an earlier task: ... answer with it.\n\n/skill:probe-alpha hello"`. User `message_end` content is the text as sent; no `<skill` block. |

### Check C: user-level versus project-level skill with the same name

Which copy wins depends on whether pi treats the folder as trusted. The list and the expansion agree.

| Launch | `get_commands` lists | Evidence |
|---|---|---|
| Squawk's launch (folder untrusted, project skills offered by `pi-project-skills.mjs`) | The **user** copy; the project copy is dropped without a record. TESTED | Scratch home: `["skill:probe-shared","user","auto","<H>/skills/probe-shared/SKILL.md"]`, no `<S>/.pi/skills/probe-shared` entry. Default home: `<U1>` and `<U2>` both resolve to `~/.agents/skills/...`; the project copies in `<S>/.pi/skills` and `<S>/.agents/skills` are absent. Tested pairs: `<agentDir>/skills` over `<S>/.pi/skills`, and `~/.agents/skills` over `<S>/.pi/skills` and over `<S>/.agents/skills`. |
| `--approve` (folder trusted, no Squawk extension needed) | The **project** copy; the user copy is dropped. TESTED | Scratch home: `["skill:probe-shared","project","auto","<S>/.pi/skills/probe-shared/SKILL.md"]`. Default home and scratch home: `<U1>` from `<S>/.pi/skills/<U1>/SKILL.md`, `<U2>` from `<S>/.agents/skills/<U2>/SKILL.md`; entries under `~/.agents/skills` fall from 6 to 4. |

- Expansion under Squawk's launch: `/skill:probe-shared` expanded the user copy. TESTED (no model call, scratch
  home): user `message_end` content `<skill name="probe-shared" location="<H>/skills/probe-shared/SKILL.md">...
  SHAREDUSER-b737e5c4 ...</skill>`; the project copy's token did not appear.
- Expansion in a trusted folder: NOT TESTED with a prompt. DOCS: `_expandSkillCommand` takes
  `resourceLoader.getSkills().skills.find(name)`, the same list `get_commands` returns, so it expands the project copy.
- No collision record reached RPC stdout or stderr in any of these runs.

### Not tested in round 2, and why

- A logged-in second pi account: the scratch home had no login, and copying or linking credentials was forbidden.
- A user skill in the real `~/.pi/agent/skills`: that folder does not exist here and user homes are read-only;
  the scratch home stood in for it.
