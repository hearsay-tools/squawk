# Probe brief: native skill listing and native skill trigger, one runner

## Why
The owner considers a redesign of Squawk (this repo, an orchestrator that runs coding agents: claude, codex,
opencode, pi, cursor, omp). Today Squawk injects a selected skill's body into the system prompt and copies skill
files into the task worktree. The proposed design: Squawk stops doing that and relies on each runner's NATIVE
skill handling. Two facts decide whether that works, per runner:

1. LIST: can Squawk ask the runner which skills it sees for a working directory, without a model call?
2. TRIGGER: can Squawk start one NAMED skill for certain (the runner loads the skill body itself; the model
   does not have to decide to load it), through the transport Squawk already uses for that runner?

You probe ONE runner (named in your task). Report tested facts only. No design, no recommendation.

## Ground rules
- Read-only for the repo and for every user-level runner home/config (`~/.claude`, `~/.codex`, `~/.config/opencode`,
  `~/.pi`, `~/.omp`, `~/.cursor`, `~/.agents`). Do not install, edit or delete anything there. Sessions the runner
  writes there by itself during a probe are accepted.
- Scratch root: `mktemp -d /tmp/skill-probe-<runner>.XXXXXX`. NOT `$TMPDIR` (it sits inside the main checkout and
  runners read ancestor folders). Make it a git repo (`git init`, one commit). Put fixture skills only there.
- Secrets: never read, print or copy credential files or tokens. For any config, print keys and paths only, never
  values (`jq 'keys'`, `env | cut -d= -f1`, `git config --list --name-only`). Never dump `env`.
- Processes: start at most one runner process at a time. Record the PID of anything you start (`$!`) and stop it
  by that PID. Never `pkill`/`pgrep -f` broadly: the host is shared with other tasks.
- The host is loaded (load average about 45 on 24 cores). Use generous timeouts (120 s for a model turn). On a
  timeout, retry once before you conclude anything.
- Cost: use the cheapest model the runner's default account offers. At most 12 model turns in total. Use
  no-model-call probes wherever one exists.
- The runner CLI is installed and logged in on the default account. Use it as it is. If auth fails, stop and
  report that; do not try to fix it.
- Do not spawn subagents. Do not use any Squawk/hsq/cez command.

## Fixture
In the scratch repo create project-level skills in every skill folder the runner reads natively (find out which:
`.claude/skills`, `.agents/skills`, `.codex/skills`, `.opencode/skills`, `.cursor/skills`, `.pi/skills`,
`.omp/skills` ... as applicable), in the `SKILL.md` directory format:

- `probe-alpha/SKILL.md`: frontmatter `name: probe-alpha`, a description that does NOT hint at the token, and a body:
  "Reply with exactly this token and nothing else: ALPHA-<8 random hex>. If the user gave arguments, append
  them after a colon." Plus `probe-alpha/references/extra.md` with a second token BETA-<hex>, and a line in
  SKILL.md: "If asked for the extra token, read references/extra.md."
- `probe-gamma/SKILL.md`: same shape, another token. It lets you tell skills apart and test a second name.

A token in the answer proves the skill body reached the model. To tell HOW it got there, read the runner's event
stream: did the runner expand the skill into the turn by itself, or did the model call a skill/read tool?

## Step 0: how Squawk drives this runner
Read the adapter in `packages/cezar/src/core/`
(file named in your task) and `AGENT_PROTOCOL.md` at that worktree's root as needed. Record: the transport
(argv or protocol), how the first prompt and later messages are sent, which flags limit tools or settings.
Run your probes through THAT transport with flags as close to Squawk's as practical, because a trigger that
works only in the interactive TUI is useless to Squawk. If a simpler mode (for example `-p`) behaves differently,
say so.

## Tests
Mark every claim TESTED (with the exact command or request and a SHORT output excerpt), DOCS (source link or
`--help` text) or NOT TESTED.

- L1 List without a model call: the exact command/request, the output shape (name, description, path, source,
  scope?), and whether it lists project skills, user-level skills and plugin skills. Does it need a running
  session, and how long does it take?
- L2 Is the list sensitive to cwd, and to the home/config-dir variable Squawk sets for a non-default account?
  (Read the adapter for the variable; test with cwd only.)
- T1 Explicit trigger: which input form starts `probe-alpha` for certain? Try the forms that apply:
  `/probe-alpha` as the whole message, `/probe-alpha some args`, `$probe-alpha`, `/skill:probe-alpha`,
  a structured skill item in the protocol, a dedicated request. For each: did the token come back, and did the
  RUNNER load the body or did the MODEL choose to?
- T2 Arguments: with `/probe-alpha hello world`, does the skill receive the arguments?
- T3 Mid-text: "Say hi, then run /probe-alpha" — runner expansion, model choice, or nothing?
- T4 Unknown name: `/probe-nope` — error event, plain text to the model, or silent? Exact stream evidence.
- T5 Prose: "Use the probe-gamma skill." (one turn; this is the model-choice path; note which tool it called).
- T6 Reference file: ask for the extra token after a trigger; can the agent read `references/extra.md`, and
  under which permission settings of Squawk's launch?
- T7 Second turn / resume: does the trigger also work in a later message of the same session and after a
  resume of that session (the way Squawk's Continue resumes)?
- T8 A skill folder added AFTER the session started: does a later turn or a resume see it? (cheap check only)

Also record: name rules the runner enforces (charset, must match folder), behavior when two folders hold the same
name, and whether listing/trigger differs for plugin-qualified names (`plugin:skill`) — DOCS level is enough.

## Output
Write the report to `.ai/analysis/2026-11-16-runner-native-skills/<runner>.md`:
runner + version, transport, a table of L1..T8 with verdict and evidence, then "Surprises" and "Not tested, and
why". Then remove your scratch folder and confirm no process you started is still running. Your final message:
the two answers (LIST yes/no + how; TRIGGER yes/no + how) in at most 15 lines, plus the report path.
