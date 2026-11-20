# Git and worktree logic

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/git-worktree.ts`, `packages/cezar/src/git-diff-base.ts`, `packages/cezar/src/server/git.ts`

## Two project directories before P5

Recognize managed worktrees under both `.ai/cezar/worktrees/` and
`.ai/squawk/worktrees/`, including owned-workspace receipts and orphan protection.
New worktrees and receipts retain the legacy write paths. Never remove or change
fallback worktree bytes. Retention and orphan cleanup skip them and print one
count per sweep. Legacy-only resource cleanup keeps all existing ownership checks.
Git common-directory discovery remains independent of either directory name.
The project migration engine (P4b2, [project routes](project-routes.md#project-state-migration-engine))
moves task worktrees with their directory, runs `git worktree repair` for them, and rewrites
only `workspace.path` in this project's owned-workspace receipts and cleanup checkpoints
(`delegation/workspace-record.ts` exports the checked receipt-file readers it uses). The admin
directory, its identity marker and the branch identity do not change, so ownership checks
still pass at the new path.

## Rules

One worktree per task at `.ai/cezar/worktrees/<runId>`, branch `cez/<id8>` off the configured base branch. Helpers never throw (except `createWorktree`) — degradation is the caller's policy. Diffs are capped (`DIFF_CAP`). At startup, an orphaned worktree (no run record) is removed only when its checkout is clean and a ref keeps its HEAD, and its branch only when another ref holds its tip; anything else stays, and the Git view lists the branch as `orphan` (hearsay-tools/cezarion#2272). **"Which ref anchors *this task's* diff" lives in exactly one place** — `resolveTaskDiffBase` (`git-diff-base.ts`): the merge-base against the **freshest** base ref (`origin/<base>` when the local branch is behind it — agents fetch, they never pull, and a stale local `main` is what turned an eight-line fix into `+59514 −12160`), and, when the agent checked another branch out into the worktree, that branch **as the run found it** (`<branch>@{<run start>}`), whichever of the two attributes fewer changed lines. Attributing a checked-out branch's history to this task is what produced five-figure numbers on review and QA runs (open-mercato/cezar#591 fixed the Changes tab, open-mercato/cezar#751 the stored `diffStat`); anchoring those runs at `HEAD` instead then reported `+0 −0` for work they really did commit. A new task-diff surface resolves through that helper and passes the run's `branch` **and** `startedAt`; `worktreeDiff`/`worktreeDiffStat` deliberately keep the whole-branch anchor and each carry a comment saying why.

**Autosave commits only on the task branch** (hearsay-tools/cezarion#1004): the turn-end and run-finalize flushes and the periodic timer go through `WorktreeAutosave.saveWorktree`, which hands `autosaveCommit` the run's recorded `branch`; when the agent checked another branch out (or detached HEAD), nothing is committed and an autosave record in the run store (`RunRecord.handoffRecords`, shown in the handoff's Squawk-owned records block, so the agent's Progress log stays its own) plus a cockpit note name the branch and the uncommitted path count. A turn-end or run-finalize commit is reported the same way, with the `git reset --soft <sha>~1` that folds it into the agent's own commits while it is still HEAD; the timer's commits go to the records only, as one merged `periodic:` record per run of consecutive periodic commits on one branch (`recordHandoffPeriodicAutosave`), since a clean closing flush reports nothing. A change to how `autosaveCommit` writes must state its guarantee against the agent's concurrent checkout, merge, cherry-pick, revert and commit in the `autosaveCommit` comment that starts "The save is not atomic", the only list of what the save guarantees today and which races it accepts (hearsay-tools/cezarion#1111). Draft-PR publish and worker destroy refuse while the worktree's HEAD is not on the task branch, with one message from `headLeftTaskBranch` (`packages/cezar/src/task-branch-head.ts`) that names where HEAD is, the task branch and the `git switch` that returns it; neither repairs it (hearsay-tools/squawk#910, hearsay-tools/squawk#1110). The pre-PR flush commits only onto the task branch, and publish reads HEAD after it, as the last step before the push. Worktree creation itself installs nothing (AGENTS.md § Validation gives the install step); a project's optional `worktreeSetup` commands (`packages/cezar/src/worktree-setup.ts`, hearsay-tools/cezarion#917, spec `.ai/specs/2026-10-07-worktree-setup.md`) run after creation and before the first agent turn, from `RunManager.execute` (tasks and workers) and `runContinuation` (a reclaimed worktree rebuilt on Continue), with the durable `RunRecord.worktreeSetup` that restart recovery reads. Worker destroy runs the project's optional `worktreeTeardown` (same shape and resolver, `delegation/worktree-teardown.ts`, hearsay-tools/squawk#914) in the proven-owned worker worktree before the termination proof and the holder scans; a failure is a `worktree teardown failed:` lifecycle event and never replaces the scans or their named refusal. The product stops no tool of its own there. Worker destroy refuses to delete uncommitted changes or commits no other ref reaches, and names them in its result's `work`, unless the caller passes `discardWork` (`delegation/workspace-work.ts`, hearsay-tools/squawk#3553); it checks before the destroy starts and again in the checked removal.

**A git killed at its timeout leaves its children running** (hearsay-tools/squawk#3941). The worktree-mutation keeper (`git-worktree-lock-helper.ts`) runs each Git command in its own process group, one at a time. A timeout kills only the `git` process; a child it started, such as the checkout of `worktree add`, stays in the keeper's group and can keep writing. Cleanup after a timeout must prove that group has exited before it retries, rolls back or releases the claim. The keeper sends SIGTERM to its group and waits up to 10 s. On Linux it lists the members through `/proc`; an empty list is the proof. Elsewhere it cannot list them, so the state is unknown and counts as running. While members may run, the result carries `childrenRunning`: `createWorktree` (`git-worktree.ts`) skips its rollback and retry, and the keeper refuses further commands. On POSIX hosts the claim stays until the group probe (`readMutationClaim`, `kill(-pgid, 0)` answering `ESRCH`) proves every member gone. Windows has no group probe, so a kept claim could never be freed there: the keeper releases it, and only the rollback and retry are skipped (hearsay-tools/squawk#1876). Do not replace the group probe with a PID or `ps` snapshot: a fork can race it.

**Every Git child starts through `packages/cezar/src/git-command.ts`** (`git`, `runGit`, `gitSync`, `spawnGit`). They drop the inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` and the other location variables, so a cockpit or CLI started from a Git hook or a `rebase --exec` step still acts on `cwd`; a caller's own `env` value (a private `GIT_INDEX_FILE`) wins. A process that runs git for us, such as `gh repo clone` or the worktree-mutation keeper, gets `gitEnv()`. The `git-spawn-outside-helper` lint rule refuses any other Git spawn (hearsay-tools/squawk#3207).

**A cockpit route reaches a run's worktree only through the run checkout module** (`server/run-checkout.ts`, [ADR 0062](../adr/0062-one-module-decides-run-checkout-access.md)): it picks the directory and the guards for each checkout intent, and the module removes nothing: run worktrees leave through `releaseThenRemoveWorktree`, owned worker workspaces through `releaseThenRemoveOwnedWorkspace` (delegation cleanup). Each route follows this rule once a slice of hearsay-tools/cezarion#3158 has migrated it. Until then the route keeps its own handler checks, and a change to it follows its Table A row in the [run checkout spec](../../.ai/specs/2026-11-10-run-checkout-module.md#table-a-each-route-and-its-checks-in-todays-order).

**A worker's workspace is reached through its kind definition** (hearsay-tools/squawk#3819): `delegation/workspace-kinds.ts` holds one definition per `workspace.kind`. Delegation code calls `workspaceKind(workspace)` or `workspaceKindOf(run)` and then the definition; it does not call a kind's own functions (`workspace.ts`, `workspace-removal.ts`, `worktree-teardown.ts`, the context placement in `context.ts`) directly, and it does not compare `workspace.kind`. The run engine imports none of them: it asks the `WorkerWorkspacePort` (`workflows/run/worker-workspace-port.ts`) that `DelegationService.registerProject` registers with `RunManager.setWorkerWorkspaces`. A worker run on a manager with no port fails; it never gets an ordinary task worktree. Whether a worker owns the directory it works in is one fact per kind, `ownsDirectory` in `packages/contract/src/delegation.ts`: the run engine reads it through `runOwnsDirectory` (`workflows/run/run-workspace.ts`), the store, the run checkout module and the cockpit read it directly. A `shared` worker does not own its directory, so its run record never gets `worktreePath` or `branch`; code that needs the directory reads `delegation.workspace.path`.

**Tools whose reports name a commit must resolve it once, then route every subsequent git call through one pinned helper**: pass `--attr-source=<sha>`, use a private index populated from that commit for index-based operations, and pass `--no-textconv` for raw-content reads. Require a PATH-shim call-log test that fails if any call after resolution bypasses the pin; see `.ai/skills/check-code-quality/scripts/changed-functions.mjs` (`pinnedGit`) and its test `every Git call after baseline resolution uses its pinned attribute source`.

## Stacked and overlapping branches

Read this before you start a branch on the head of an open pull request, or before two parallel
workers or slices edit one file. Campaigns follow their own stricter rule instead:
[campaign skill](../../.ai/skills/campaign/SKILL.md) and its
[hot-file release](../../.ai/skills/campaign/references/hot-file-release.md#preserve-progress-when-patches-overlap).

**After the base pull request is squash-merged, restack with one command**
(hearsay-tools/squawk#3970):

```sh
npm run restack -- <base PR number>             # replay only this branch's own commits onto origin/main
npm run restack -- <base PR number> --merge     # keep the history: merge commits only, no force-push
npm run restack -- <base PR number> --dry-run   # list the commits it would replay; change nothing
```

Git reads the base's commits and the squash commit as different changes, so a plain
`git merge origin/main` or `git rebase origin/main` conflicts in files this branch never changed.
Merging the base's final head first does not help. `scripts/restack-after-squash.mjs` reads the
base's final head from GitHub (`headRefOid`, fetched from `pull/<N>/head`, so a deleted branch
works) and runs `git rebase --onto origin/main <final head>`. With `--merge` it merges the final
head, then `origin/main` with the final head as the merge base, and writes nothing on a conflict.
It refuses on an unmerged PR, a dirty tree, a detached HEAD or a branch that was not stacked on
that PR. It never pushes: it prints the push command, with a lease on the old head after a rebase,
and says whether the branch's own patch is unchanged, so that no new review round is needed.

**Two slices that edit one file**, outside a campaign, in this order of preference:

1. Cut the slices so that their file sets do not overlap.
2. One slice owns every edit to the shared file.
3. The second slice starts after the first merges.
4. Last resort: the second slice starts on the first one's head and restacks with the command above
   after the first is squash-merged.

A rebase over a shared file sends a pull request through review and every check again. With 2, 3
or 4, both pull request bodies name the shared file and the merge order.
