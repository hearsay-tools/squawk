---
name: auto-merge
description: Auto-merge for pull requests into `main`. Use when opening a pull request, before and after each push on it, and after each CI result, review round or draft/ready change on one you opened with the `auto-merge` label.
---

# Auto-merge

The owner runs `main` on the dev channel for a while before each release, so a
merge reaches dev within minutes and the owner meets it there before users do. A
pull request that passes this decision merges on its own once its required checks
pass. Every other pull request waits for the owner, as before.

## Decide

Commit everything, then run from the repository root:

```bash
git fetch origin main
node .ai/skills/auto-merge/check.mjs --title "<PR title>"
```

The script checks the title type, the size (at most 10 files and 400 lines) and
the never-lists of paths and diff content. Its constants are the rules. Then
confirm the rules the script cannot see:

- The owner has not paused auto-merge:
  `gh api repos/hearsay-tools/squawk --jq .allow_auto_merge` prints `true`.
- You are opening this PR in this task, from a branch of
  `hearsay-tools/squawk`, into `main`.
- The user did not ask to review the PR before it merges.
- Every issue the PR closes (`Closes #N`, `Fixes #N`) is complete with this PR.
  When part of an issue stays open or moved elsewhere, write `Refs #N`.
- Every instruction an agent session reads keeps its wording: prompt strings,
  tool descriptions and guidance text, wherever they live (for example in
  `workflows/run.ts` and `workflows/waits.ts`). The script covers only the files
  that are mostly prompt text.

**Done when** the script prints `QUALIFIES` and every rule above holds: read
[`.ai/skills/auto-merge/references/open.md`](references/open.md) and open the PR
as it says. A rule you are unsure of does not hold. On any other outcome, open the
PR the usual way, without the label; this skill is then finished.

## Arm it only after the review

A qualifying PR does not merge on checks alone. Arm
`gh pr merge --auto --squash` only when both hold for the PR's current head:

- The reviewer round has no blocking finding: no finding scored 5 or more.
  Findings scored 4 or lower do not block; list them in the PR body.
- `node .ai/skills/auto-merge/arm-check.mjs --pr <n>` prints `ARM <sha>`: no
  review thread is unresolved. The review apps post threads after CI and the
  reviewer round settle ([Review apps](../../../docs/sdlc/ci.md#review-apps)). Auto-merge waits for no quality
report: CI's `complexity-gate` job blocks complexity growth over 20, and CRAP is
reported in CI without blocking
([Before a PR](../check-code-quality/references/pre-pr.md)).

Before any later push to a PR with auto-merge armed, turn it off
(`gh pr merge --disable-auto`). An armed request never carries across a push:
arm it again only when the precondition holds for the new head.

Like the review round, this arming rule is an agent rule: queue admission
checks native CI and review threads only, and removes a queued PR with an open
thread. GitHub enqueues
the PR when its required checks pass.

## Labeled PRs

Before each push to a PR you opened with the `auto-merge` label, and after
each push, CI result, review round and draft/ready change on it, read
[`.ai/skills/auto-merge/references/follow.md`](references/follow.md) and act on it.
