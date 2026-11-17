# Workflows

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/workflows/types.ts`, then `packages/cezar/src/workflows/load.ts`, `packages/cezar/src/workflows/run.ts`, `workflows/run/`

## Two project directories before P5

Union `.ai/cezar/workflows/` and `.ai/squawk/workflows/` by name. Names in the
legacy directory hide the same names in fallback; preserve same-directory
behavior. File workflows retain precedence over built-ins. Saves stay under the
legacy directory. Deletion refuses if the name also exists in fallback and names
that path with the instruction to use the binary that migrated the project.

## Rules

A step is agent (`prompt`/`skill`) XOR check (`command`); a file has `steps` XOR the portable `skills` shorthand — both enforced by zod refinements. `onFail.retry` may only reference an _earlier_ step (`stepsIssue`). `{{task}}` is the substitution token. `quick-task` is the built-in zero-config workflow; built-ins always come back after delete.

## Workflow format

A workflow is a small YAML file in `.ai/cezar/workflows/`:

```yaml
name: fix-and-verify
description: Implement the task, then verify; retry with failing output on red.
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
    skill: project-conventions   # optional — a skill id reported by this step’s runner
    # model: opus                # optional per-step model override
    # effort: high               # optional per-step effort: low · medium · high · xhigh · max
    # runner: codex              # optional per-step backend: claude · codex · opencode · cursor · pi · omp
    # timeoutMs: 7200000          # optional agent-step wall-clock cap (2 hours); 0 = no limit
    # allowedTools: [Read, Edit, Write, Grep, Glob, Bash]
  - id: verify
    name: Verify
    command: "npm test"          # a check step: exit 0 passes
    onFail:
      retry: implement           # loop back to an earlier step…
      max: 2                     # …at most twice
```

`skill:` names a runner skill id, not a file path. Step open lists the selected runner
for the step's account and working folder and checks the id before a model call.
Name-only duplicates use the scope rule in [Skills](skills.md#selected-skills-and-paths).
Workflow files and the `skills:` shorthand carry no `skillPath`; that field belongs only
to inline run steps and stored run steps.

`{{task}}` is replaced with the task text you typed. When a check fails and loops
back, its failing output is appended to the retried agent's prompt so the next
attempt can see what broke.

Agent steps have no wall-clock limit by default, including steps before a check or
another agent. This applies to cockpit tasks, owned workers and `hsq run`, on every
runner. Non-final agent steps still close after their turn and advance the chain.
An authored agent step may opt into `timeoutMs`: an integer from `0` to `2147483647`
milliseconds, with `0` disabling the cap. A positive limit measures the entire
session from startup, including waiting; expiry fails the step and stops the chain.
It does not add workflow retry/resume behavior. Check steps reject this field.
Skill shorthand, default tasks and free-form Continue have no wall-clock cap.
All managed sessions have a separate 30-minute no-progress safeguard: while a turn
is open, native stream, tool or heartbeat activity refreshes it. A silent turn
fails and its process is terminated, with SIGKILL escalation if needed. Busy turns
can run longer than 30 minutes. Waiting at a turn boundary or for a human answer
pauses this safeguard; the next turn or answer rearms it. Standalone runner calls
keep their 30-minute wall-clock default. Startup protection and the existing
parked-session lifecycle still apply.

Prefer skills over steps? A workflow can also be written in the portable
shorthand — an ordered list of skill names, each becoming one agent step:

```yaml
name: triage-and-fix
skills: [reproduce, root-cause, implement, self-review]
```

---
