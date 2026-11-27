# Session-start context

Squawk puts context at the start of the opening message of every session it launches. The
agent then has its handoff notes, and any project context you add, without spending a tool call
to read them (hearsay-tools/cezarion#1584).

## When it applies

Context is added when Squawk launches a session:

- a fresh agent step, including a later step of a workflow;
- a step that runs again after a failed check (`onFail.retry`);
- **Continue**, from the cockpit or `hsq task send <id> … --resume`;
- restart recovery, the usage-limit auto-resume and other scheduler continuations;
- an owned worker's sessions, which render the context for the worker itself.

Ordinary messages you send to a live session get no context. Native compaction inside a
session does not add it again.

## The handoff block

The first block is always the run's own handoff file (`HSQ_HANDOFF_FILE` (`CEZ_HANDOFF_FILE` fallback)), complete: Goal,
Progress log, Resume notes and Squawk's records block, which the launch first renders from the run
store (hearsay-tools/cezarion#1809). It needs no configuration, and it cannot be
turned off or replaced. A worker gets its own handoff, never its parent's.

When the handoff is in the message, the system prompt tells the agent so, and asks it to read the
file again only for a later version. When the handoff could not be added (the file is missing or
unreadable, or it does not fit the limit), the system prompt keeps the instruction to read the file.
The agent still has to keep the Progress log and the Resume notes up to date in both cases.

## Project rules: `context.yaml` and `context.local.yaml`

Add project context with two optional YAML files in the project root (`.ai/squawk/` in a project
that starts there or has moved; `.ai/cezar/` in a project that has not):

- **`context.yaml`** (shared): committable team rules tracked in Git. Squawk’s own `.gitignore`
  does not list it.
- **`context.local.yaml`** (local): host-only rules and overrides. Squawk ignores it automatically
  in `.ai/squawk/.gitignore`, `.ai/cezar/.gitignore`, and `.git/info/exclude`, so local edits never
  dirty `git status`.

Squawk reads both files from the project root (the checkout Squawk runs in), never from the task
worktree, while `{{file:…}}` paths inside templates resolve inside each task’s worktree. A missing
file means no rules from that layer, with no warning. When your repository ignores the whole
`.ai/cezar/` or `.ai/squawk/` directory, ignore its contents instead and re-include `context.yaml`;
Git cannot re-include a file inside an ignored directory:

```gitignore
/.ai/squawk/*
!/.ai/squawk/context.yaml
```

```yaml
version: 1
rules:
  - id: project-vision
    on: session_start
    target: both
    template: |
      Project vision:
      {{file:docs/vision.md}}
  - id: worker-brief
    on: session_start
    target: worker
    template: |
      You are worker {{run.id}}. Report to your parent before you finish.
```

| Key | Meaning |
| --- | --- |
| `version` | Required. Must be `1`. |
| `rules` | A list. Rules are rendered in file order, after the handoff. |
| `id` | Required and unique within a file. 1–64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. `handoff` is reserved. |
| `on` | Required. `session_start` is the only trigger. |
| `target` | `parent`, `worker` or `both` (the default). `parent` is every task that is not an owned worker. |
| `enabled` | Optional boolean (`true` by default). Set `enabled: false` to disable a rule or mute a shared rule locally (`template` may be omitted when `enabled: false`). |
| `template` | Required unless `enabled: false`. Text with `{{…}}` substitutions. |

### Layering and overrides

Launches load the handoff block first, then shared rules from `context.yaml`, then local rules from
`context.local.yaml`, all within the 65,536-byte cap:

- **Cross-file `id` override:** A valid rule in `context.local.yaml` with the same `id` as a rule
  in `context.yaml` replaces that shared rule in place (keeping its shared budget slot) and reports
  `overrides context.yaml` in the launch lifecycle line.
- **Local mute:** A rule in `context.local.yaml` with the same `id` and `enabled: false` mutes the
  shared rule locally and reports `muted by context.local.yaml` (no `template` needed).
- **Same-file duplicates:** Duplicate `id`s within a single file still skip every rule that carries
  that `id` in that file.
- **Layer isolation:** A malformed or unreadable `context.yaml` skips only shared rules; local
  rules and the handoff still run (and vice versa).

### Edit the rules in the cockpit

**Project Settings → Session context** shows the built-in handoff block, then a **Local** /
**Shared** workspace beside a **Combined preview**:

- **Local (`context.local.yaml`, default):** Editable YAML editor with **Add rule** and variable
  chips. Saving auto-ignores `context.local.yaml` so edits never dirty `git status`. Squawk never
  rewrites the YAML, so your comments and formatting stay.
- **Shared (`context.yaml`):** Read-only view showing whether the file is tracked in Git
  (`Tracked in Git`, `Untracked · repo file`, or `Not in repo`). Team changes go through normal Git
  review; host overrides go in **Local**.
- The server checks the local draft as you type and lists each problem with its line: YAML that
  does not parse, another `version`, a rule field that is not valid, the reserved `handoff` id and
  every rule that shares an id in `context.local.yaml`. Save stays off until no problem is left,
  and the draft stays. Broken shared YAML does not block fixing or saving local rules.
- The **Combined preview** renders the handoff, shared `context.yaml` on disk, and the unsaved local
  draft together for a parent or a worker. It reads `{{file:…}}` paths from the project checkout
  and shows sample values such as `<run.id>` for task variables. Each block shows its layer
  (`built in`, `shared`, `local`, or `local · overrides shared`), status, size and any skip reason.
  The meter shows the bytes used against the 65,536-byte limit.
- A save is refused when `context.local.yaml` changed on disk after you opened it. You can show the
  disk version, or overwrite it. Your draft stays either way.
- A file that is not valid UTF-8, too large, or not a regular file is read only. So is a copy in
  the fallback project directory, and a file reached through a symbolic link, so the editor cannot
  write another file such as `config.json`. Two saves never pass the version check together.
- Squawk does not commit any file. The rules apply from the next session launch.
- A remote cockpit can save `context.local.yaml` without `remote-settings enable`. The file runs no
  host command, and its file includes cannot leave the worktree
  ([ADR 0055](adr/0055-grant-remote-settings-administration-from-the-host.md) gates only settings
  that persist host commands).

The routes are `GET /api/v1/p/:projectId/session-context` (returning `{ local, shared }`),
`PUT …/session-context` (saving `context.local.yaml` over its version and returning `{ local, shared }`)
and `POST …/session-context/preview` (combined preview of shared on disk + local draft).

### Substitutions

| Token | Value |
| --- | --- |
| `{{task}}` | The run's task text |
| `{{run.id}}` | The run id |
| `{{role}}` | `parent` or `worker` |
| `{{workflow.name}}` | The workflow name |
| `{{step.id}}` | The id of the step being launched |
| `{{project.root}}` | The project root |
| `{{worktree.root}}` | The session's working directory |
| `{{handoff.path}}` | The run's handoff file |
| `{{file:<path>}}` | The contents of a file, by a path relative to the session's working directory |

Substitution is one pass over the template. Text that a variable or a file inserts stays
literal: a `{{…}}` inside it is not expanded. A `{{file:…}}` path must stay inside the session's
working directory after symlinks resolve; absolute paths, `..` escapes and symlinks that leave
the worktree are refused. A file must be valid UTF-8. There are no commands, conditionals,
loops, globs or remote sources.

Squawk reads the rules and the files again for each launch. The text a launch receives does not
change after the launch starts.

## Limit

The whole prefix, labels and separators included, can be at most 65,536 bytes of UTF-8. The
handoff is added first, then the rules in file order. A block that does not fit is left out whole,
never cut, and the later blocks are still tried.

## What the agent sees

```text
<cezar-context id="handoff" source="/path/to/.ai/cezar/runs/<run>.handoff.md">
# Handoff — …
</cezar-context>

<cezar-context id="project-vision">
Project vision:
…
</cezar-context>

---

<the opening message>
```

When the opening message starts with a slash command (`/name`), the launch gets no context, so
that the backend still sees the command at the start. The agent keeps the instruction to read the
handoff file.

## Errors and reports

Errors never stop a launch:

- A `context.yaml` or `context.local.yaml` that cannot be read or parsed, or has another `version`,
  skips only that layer’s rules. The handoff and the other file’s rules still apply.
- An invalid rule, a duplicate `id` within the same file (every rule that has it), the reserved
  `handoff` id or an unsupported `on` value skips that rule.
- A rule with `enabled: false` is skipped (`muted by context.local.yaml` when it mutes a shared
  rule, otherwise `disabled`).
- An unknown or unavailable variable, or a missing, unreadable, non-UTF-8 or outside file, skips
  that rule.
- A block over the limit is skipped.

The other rules still run. Each launch writes one lifecycle line to the task log, which the
cockpit and headless `hsq run` both show:

```text
session context: handoff applied (2431 B, /…/runs/<run>.handoff.md); project-vision skipped (docs/vision.md) — file docs/vision.md: not found
```

The line names each block, its size, the files it read and why it was skipped. It never contains
file contents. `applied` means the block is in the launch's opening message, not that the provider
confirmed it.

## Native resume

A runner that resumes its own native session keeps that session's history. Context injected at
an earlier launch stays in the history, and native compaction can summarize or drop it; Squawk
does not add it again until the next launch. Claude keeps the system prompt of a session's first
launch when it resumes (see `SystemPromptOnResume` in
`packages/cezar/src/core/agent-runner.ts`), so a session that started before this feature
can still be told to read the handoff file. Both instructions are safe: the file is the same one.
