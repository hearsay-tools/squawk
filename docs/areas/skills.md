# Skills

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/core/runner-skill-catalog.ts`, `core/host-skill-catalog.ts`,
`core/runner-skill-reference.ts` (all under `packages/cezar/src/`), then
`packages/cezar/src/server/runner-skills.ts`, `packages/cezar/src/workflows/run/run-skills.ts`
and `packages/cezar/src/worktree-skill-cleanup.ts`.
[ADR 0066](../adr/0066-use-runner-native-skills.md) records the decision.

## Lists and accounts

A skill is an entry the selected runner reports. Squawk lists metadata and sends native
triggers. It reads no skill file, injects no skill body and installs no skills.
The runner owns discovery, including project folders, user skills and plugins.
Skills follow the step's account home, not a shared Squawk library (D1).

`GET /runner-skills?runner=<id>&account=<account>` is project-scoped under
`/api/v1/p/:projectId` (the boot project's `/api/v1` form also works). An omitted account
uses the project's session account. The response holds `runner`, `skills`, `problems`,
`source` (`live`, `cache` or `unavailable`) and an optional `reason`.
Each entry has `id`, `name` and optional `description`, `scope`, `plugin` and `path`.
Use `id` for references and triggers; `name` is display text.
Do not fill missing metadata by reading files.

The server shares one `RunnerSkillCatalog`, keyed by runner, account home and working
folder. Its default cache lifetime is 300 seconds. Concurrent reads join; each probe has
a deadline. `refresh=1` invalidates the entry before reading. A failed probe retains the
last good list with a reason, or answers `unavailable` when none exists.
A picker with an unavailable list still accepts a typed id; step open checks it.

## Selected skills and paths

At step open, load the list for the step's runner, account and working folder. Resolve the
selected `{ id, path? }` before any model call. A missing id, stale path or ambiguous id
fails the step with the runner, account and listed paths in the error.
A project skill must exist in the task worktree: track its native folder or arrange its
links through `worktreeSetup`. Squawk does not copy ignored project skills (D4, D5).

A path selects exactly one listed copy. Without a path, one matching entry wins. For
multiple entries, apply D8: `repo` wins over `user`, then `system`. Equal best scopes, or
any missing/`other` scope among the copies, are ambiguous. Codex's `admin` maps to `other`.
Never choose the first entry just because it arrived first.

Only inline `steps` in `POST /runs` and stored run steps carry `skillPath` alongside `skill`.
The list response makes paths inside the listed folder relative; external paths stay
absolute. Resolve a relative path against the step's working folder before matching it
against that folder's native list. This keeps a project pick valid in a task worktree.
Workflow files, saved workflow definitions, automations, the task CLI and
`worker spawn --skill` carry ids only. Do not add paths to these portable references.

The selected skill becomes `AgentRunSpec.skill = { id, path?, args }`; the step prompt is
its arguments. Each adapter owns the trigger and the placement of opening context
([AGENT_PROTOCOL.md §6](../../AGENT_PROTOCOL.md#6-backend-parity--the-hard-rule-packagescezarsrccoreui-paritytestts)).
A resumed Continue sends no trigger. Pass the checked step trigger as `resumeFallbackSkill`
so an adapter that opens a fresh session triggers it with the Continue message as arguments.
The `session` event's `resumed` value records what happened. When Continue finds that the
owning step's recorded `skillPath` disappeared from the runner's list, it falls back to
resolving the skill id under D8 scope precedence instead of failing immediately. If the id
resolves uniquely, Continue updates `skillPath` on the Continue step and owning step to the
newly resolved portable path and emits a note naming the old and new paths. Continue still
fails before any model call when the id is missing or remains ambiguous under D8. Step open
keeps strict `skillPath` matching.

## Typed names and session visibility

A leading `/name` in the session's list becomes a first-position `skill` content block (D3).
An unknown name remains unchanged text so native slash commands still work.
Use the declared facts in `core/runner-facts.ts`, never a runner-id branch:

- `skillsSeenBySession`: keep the opening list for `at-start` sessions; re-read for `live`
  sessions. If only a fresh list holds the name, send the text and note that the skill is
  available after the next Continue.
- `skillTriggerMidTurn`: hold a known trigger during a busy turn when false; resolve it when
  the held message is released (D6).
- D8 also applies to typed names. An ambiguous name stays text with a note naming every path.
  It does not fail the step. The user can pick a specific copy or remove a duplicate.

Squawk handles only a leading `/name`. omp can also expand `/skill:<name>` elsewhere in a
message; Squawk does not intercept that native form.

`state.skills.catalog` holds the list read for the session. `loadRunSkills` owns its writes;
`enabledSkills` owns its reads. Preserve the skill ownership lint guards. A change to skill
availability needs a [reader sweep](../../CODE_REVIEW.md#changing-working-behavior) across
step open, Continue, input release, workers, planner, compose, auto-naming and the task CLI.
Worker lookup uses the worker's runner and account. The planner uses the project default
runner's list; a step that selects another runner is checked at step open.

## Cockpit

Pickers use the target step's runner and account. Show duplicate ids as separate entries
with their paths. A pick carries `{ id, path? }` through the draft to the inline run step;
`lastTask` and `recentSources` in `ui-state.json` retain ids only. A recent id that matches
two entries offers both. Saved workflows retain only the id.

The Skills page is a read-only inventory for one runner and account. Show the runner's
metadata and problems and offer Re-read. Skill details show metadata, not file contents.
Installing or editing a runner's skills belongs to the runner's own tools.

## Old task worktrees

Before native listing at step open and Continue, `cleanupTaskWorktreeSkills` checks that
the working folder resolves to the recorded task worktree and differs from the main checkout.
The manifest's `skills` writer removes only recorded, unchanged entries and Squawk-owned
ignore files. Changed, unrecorded and unverifiable content stays; kept recorded copies stay
excluded from git. Skill entries are handled before ignore files; records are saved last,
so an interrupted cleanup can repeat. A failure leaves records for retry and emits a best
effort note without blocking launch. A worktree without records is untouched.
See [migration](../migration.md#runner-native-skills) for saved settings and leftover caches.
