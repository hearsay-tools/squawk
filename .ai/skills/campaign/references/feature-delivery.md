# Feature delivery

This path includes new features and behavior-changing fixes. Its contract is
the approved behavior and the guarantees that must survive.

## Readiness

Use `plan-issue` and `refine-scope` for product decisions, the design gate and
plan freshness. An epic plan can supply shared decisions, but each slice still
needs a current, executable handoff. A raw issue list is not an approved plan.
If a required planning skill is unavailable, name that blocker before dispatch.

For each slice, record:

- The approved plan revision, user-visible result and explicit scope limits.
- Preserved guarantees and intentional behavior changes. An existing test's
  expected outcome changes only with the named guarantee, its replacement and
  the approval that authorizes it (AGENTS.md).
- Acceptance criteria mapped to checks, including integration checks shared
  with other slices. Name who runs each check and at which phase exit.
- Interfaces, stored-state changes, dependencies and release conditions.
- Behavior on main after this slice alone, at shipped defaults. If it cannot
  work safely before another slice, change the cut or order before spawning.

Put the case tables AGENTS.md requires in the approved plan. Preserve zero
config: a default-off replacement does not preserve an existing working path.
Use the relevant ADRs and area rules for compatibility, recovery and API shape.

Done when every criterion has an evidence path, every prerequisite has a
release check, and product decisions that affect implementation are resolved.

## Worker brief

Fill this with the admitted item's facts. Use the existing implementation
workflow; the cleanup shortcut does not apply. Coordinator-owned administration
below is the campaign-specific override to that workflow.

```text
Implement <repository-qualified issue> from approved plan <path/comment and
revision>. Read <shared epic decisions> and <relevant area rules/ADRs> first.
Coordinator: <run id>. Merge authority: <owner's words, or "The owner merges">.
PR-opening gate: coordinator actual-overlap release check for every ready branch,
even without a predicted hot file. Report a complete committed head and readiness
evidence; request release and
open only after an explicit reply for that head. A changed head or base
invalidates release: request a fresh check under campaign/references/hot-file-release.md.

Use implement-issue from its current approved Plan handoff. Follow its
verification, code-quality, PR-body and PR-checks rules. The coordinator owns
the issue claim, board, labels, landing and friction posts. Send required label
requests to it before the first push that needs them. Open the PR ready, not
draft. Read auto-merge before opening the PR; owner-merge mode
requires owner review, and this worker leaves landing to the coordinator/owner.

Review round: after implement-issue's verification passes and before its push
and PR step, commit and run one review round on the committed head. Run the
worker spawn command of the pre-PR review rule in your prompt as it is, with a
new request id. From a worker it starts a shared-workspace worker in this
worktree. The task names the branch, the head SHA from git rev-parse HEAD and
the base. It names the PR when one exists; else it says that none exists yet.
It says to read commits with git show and never check out, to change no file,
and to send the full report to its parent and then call cezar_done. Do not
edit the worktree while the round runs. Register worker wait <id> and end your
turn. One round has a total time limit of one hour, counted from the spawn;
the limit is this brief's rule, not a Squawk timeout. Within it, register the
wait again after a wake on a message or a deadline, with a --timeout-seconds
of at most the time left. When the hour has passed and the reviewer has not
settled: run worker stop <id>, then worker destroy <id>, and count a failed
round.
A round is valid only when all three hold: worker collect <id> says settled
true and partial false; the reviewer's full report has arrived as a message
(the collected summary is not the report); and the collected result's changes
field is unchanged (docs/workers.md § Run a review round from a worker). A
reviewer that failed, was cancelled, or settled with no report, and a round
whose changes field is changed or unavailable, is a failed round: run worker
destroy <id> and run the round again. Run worker destroy <id> before every next spawn: you
may have one outstanding worker.
A finding scored 5 or more: fix it, commit, and run one round on the fix only.
Findings scored 4 or lower do not block; list them in the PR body
(.ai/skills/auto-merge/SKILL.md § Arm it only after the review). When the
spawn is refused or after two failed rounds, run the same prompt in a native
subagent of your runner and say so in the PR body. docs/workers.md § Run a
review round from a worker has the commands and the detail. git rev-parse
HEAD must still print the head SHA that the round's task named; else run the
round on the new commits. Then send the release request for that SHA; push and
open the PR only after the coordinator's reply. Run the round again on the new
commits after any later code change. A round on a pushed head while the PR is open: mark it
with node .github/scripts/pre-pr-review.cjs open|blocked|clean --head <sha> --pr <n>
(.ai/skills/auto-merge/SKILL.md § Show an open review round on the PR). Never add
the PR to the merge queue or remove it. A push refused with GH006 (the PR is
queued) goes to the coordinator as a request; do not dequeue and do not push again. Commit attribution follows your runner's
own prompt; this brief adds none.

Deliver: <acceptance criteria and evidence checks>.
Preserve: <existing guarantees>.
Intentional changes: <approved old-to-new behavior>.
Prerequisites accepted on main <SHA>: <release checks and results>.
Shared contracts/resources: <names and permitted changes>.
Expected regions: <files and ranges, as estimates rather than an export ban>.
Integration evidence: <checks, owner and phase exit>.

Use meaningful commits and send a progress message after each with its SHA,
scope and evidence. Request a coordinator decision before changing approved
behavior, a shared contract, acceptance criteria or a dependency. Wait for an
explicit reply; keep any independent in-scope work moving meanwhile.

Run the applicable checks from AGENTS.md § Validation and
CODE_REVIEW.md § Changing working behavior. Use Squeal for
covered suites, and run build, typecheck and packaged checks when required.
For a regression fix, prove the regression fails at proof_base and passes
with the fix. Record preserved guarantees when changing a test's expectation.

Report the PR, head, criterion-to-check results, changed contracts,
limitations and friction. Fix in-scope CI/review findings; report inherited
failures with evidence. Register a PR wait. Rebase only when the coordinator
requests it, push with --force-with-lease, then refresh affected evidence. If
your baseline was another PR's head and that PR was squash-merged, restack with
npm run restack -- <that PR> (docs/areas/git-worktree.md § Stacked and
overlapping branches), never a plain merge or rebase of origin/main.

When checks and review are clear, report readiness at the exact head and
finish the worker with cezar_done. A settled worker can be resumed for review
or repair. Keep the branch on cez/<id8> and keep the handoff current.
```

## Review

Read every commit and compare the full diff with the approved behavior. For
each acceptance criterion, inspect the evidence and its limits. Trace shared
contracts into their consumers; use the Reader sweep for names and defaults.
Check the preserved guarantees and relevant plan case tables, including
failure, restart and absent-input cases when the mechanism needs them.

An additive feature need not fail the whole old suite: demonstrate its new
behavior at the appropriate boundary. A regression fix still needs the repo's
red/green proof. Test changes must preserve unrelated guarantees.

Done when every criterion and preserved guarantee is accounted for at the
current head, required findings are resolved, and cross-issue checks have an
assigned owner and phase exit. A deferred check may hold phase acceptance;
it cannot stand in for a required pre-merge check.
