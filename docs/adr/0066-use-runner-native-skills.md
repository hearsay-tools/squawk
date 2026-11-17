# Use runner-native skills

Supersedes [ADR 0023](0023-treat-skills-as-shared-content.md).
Approved design: [runner-native skills](../../.ai/specs/2026-11-16-runner-native-skills.md),
including the owner's decisions D1 and D3 to D8 of 2026-11-16.

## Decision

A skill is what the step's runner lists for its account home and working folder.
Squawk asks the runner for metadata and starts the selected entry through its native trigger.
The runner owns discovery and expansion. Squawk reads no skill file, installs no skill and
puts no skill body into a system prompt.

The [spec's product decisions](../../.ai/specs/2026-11-16-runner-native-skills.md#product-decisions-owner-2026-11-16)
are binding:

| Decision | Effect |
| --- | --- |
| D1 | Skills follow the step's account home. Changing account can change the list |
| D3 | A known leading `/name` uses the runner's trigger; an unknown name stays text |
| D4 | A project supplies tracked native skills or links through `worktreeSetup`. A selected skill absent from the worktree fails before a model call |
| D5 | Squawk-only skill folders cease to be sources. This repo exposes its existing skill files through tracked native-folder links |
| D6 | Hold skill input until the turn ends when `skillTriggerMidTurn` is false |
| D7 | `cezar_automation` replaces the built-in automation skill, with paused creation and preview-before-enable enforced by the tool |
| D8 | A path selects a listed copy. Name-only duplicates resolve by `repo` over `user` over `system`; an equal best scope or an unknown scope is ambiguous |

A selected missing, stale or ambiguous reference fails at step open. An ambiguous typed name
stays text with a note naming the paths. Run-only `skillPath` preserves a picked copy across
worktrees and Continue; portable workflows and automations keep ids only.
A resumed Continue does not trigger again. A fresh-session fallback does.

## Consequences

- Squawk has no team-source catalog, per-skill off-list or worktree skill installer. Teams
  share skills through their runner's project configuration or tracked native folders.
- Lists can differ between runners and accounts. The read-only Skills page and all pickers
  use the target runner and account. Cache keys include the working folder and account home.
- Session visibility and busy-turn admission are declared runner facts. Shared code reads
  those facts; it does not infer behavior from a runner id.
- Saved runs, transcripts and home config still open. Old `skillsRepos` and
  `disabledTeamSkills` keys are ignored. User cache clones are left on disk.
- Before listing at step open or Continue, old task worktrees lose only recorded, unchanged
  installed copies and owned ignore files. Edits remain excluded from git. Cleanup keeps
  durable records until last and retries after interruption. Failure reports a nonblocking
  note. It never cleans the main checkout or an unrecorded folder.
- The owner chose no extra code for races that exist only while cleaning an old worktree.
  The conservative manifest checks and repeatable cleanup remain the boundary; this decision
  adds no new locking or race machinery for that one-time transition.
- Claude managed-policy hooks were not tested by the list probe. User and project hooks are
  disabled for that probe; user settings cannot disable managed hooks. The
  [probe report](../../.ai/analysis/2026-11-16-runner-native-skills/claude.md) records the limit.

## Considered Options

- **Keep Squawk's shared catalog and provision copies.** Rejected. It duplicates the runner's
  skills and can expose a different list from the one the session can trigger.
- **Keep account-independent global skills.** Rejected by D1, reversing ADR 0023.

Implementation and reader rules: [skills area](../areas/skills.md).
Evidence: [list probes](../../.ai/analysis/2026-11-16-runner-native-skills/slice1-evidence.md),
[trigger probes](../../.ai/analysis/2026-11-16-runner-native-skills/slice2-evidence.md),
`core/runner-skill-reference.test.ts`, `workflows/native-skill-input.test.ts` and
`worktree-skill-cleanup.test.ts` under `packages/cezar/src/`.
