# Cleanup delivery

**Behavior-neutral** means every existing test keeps its expected outcome and
no user sees a difference: API shapes, CLI output, UI and stored state stay the
same. Quote the deciding acceptance criterion before admission. A behavior
question becomes a linked issue; a cleanup PR preserves the existing behavior.
Changing that contract requires a feature plan before dispatch continues.

Measure the issue's named target on current main and after integration: lines,
bytes, complexity or the agreed test-quality metric. For complexity, use
`squeal code <file> --json`.

## Worker brief

The coordinator pastes this text after the per-issue facts, fills each `<…>`,
and keeps the section for the issue's kind. It replaces dev-flow for cleanup
workers: across 25 PRs of hearsay-tools/cezarion#2051, dev-flow's own steps
caught nothing, and the coordinator's gate does its checks.

```text
Work hearsay-tools/cezarion#<N> to a ready PR with green CI. This brief replaces
dev-flow: load none of dev-flow, plan-issue, implement-issue, run-preflight,
pr-checks or log-friction. This shortcut applies only to approved cleanup work.
The coordinator owns the board, the claim, labels, landing and the friction log.
Coordinator: <run id>. Merge authority: <owner's words, or "The owner merges">.
PR-opening gate: coordinator actual-overlap release check for every ready branch,
even without a predicted hot file. Report a complete committed head and readiness
evidence; request release and
open only after an explicit reply for that head. A changed head or base
invalidates release: request a fresh check under campaign/references/hot-file-release.md.
If your baseline was another PR's head and that PR was squash-merged, restack with
npm run restack -- <that PR> (docs/areas/git-worktree.md § Stacked and
overlapping branches), never a plain merge or rebase of origin/main.

The change is behavior-neutral: every existing test keeps its expected outcome.
The issue and the facts above are the approved plan. Ask the coordinator, and
wait for the answer, before you change anything the issue does not name. A
behavior question goes to the coordinator; the PR keeps the old behavior.

The issue's numbers (counts, sizes, costs) are a hint, not a target. Measure the
acceptance target before you start and again after each rebase or merge of main,
with the command the issue names, or node scripts/import-reach.mjs for an import
count. Put the measured numbers, the command and the commit in the PR.

Work in <2 or 3> committed steps: <step list>. After each commit, send the
coordinator a progress message with the SHA and what it moved or changed.

Before the PR, in this order:
1. Make the change. Grep tests, testkits and browser specs for every name you
   move, rename or remove (CODE_REVIEW.md § Changing working behavior).
2. Read the applicable AGENTS.md area rules. Run npm run typecheck -w @wjarka/cezarion:
   the three tsc configs tsconfig.json, tsconfig.test.json and
   tsconfig.scripts.json. It needs no build.
3. git fetch origin; node .github/scripts/check-clones.cjs --base origin/main
   --head HEAD; node .github/scripts/check-citations.cjs.
4. Read focused test results through Squeal as AGENTS.md § Validation says;
   for a verdict now, run squeal run tests|run-loop <files> --wait 60000. Use
   npm test -- <files> only for the exceptions that section names. Packaged
   CLI checks and browser specs run in CI.
5. Commit, then run check-code-quality's pre-PR complexity gate, as its
   reference says. CI's complexity gate counts a moved function as new when a
   same-named delegator stays behind; tell the coordinator about any function
   over 20.
6. <kind section below>
7. Run git fetch origin main, then npm run prepr; it covers steps 2 and 3.
   A complexity gate failure blocks the PR. Commit what it changes.
8. Review round, on the committed head. Run the worker spawn command of the
   pre-PR review rule in your prompt as it is, with a new request id. From a
   worker it starts a shared-workspace worker in this worktree. The task
   names the branch, the head SHA from git rev-parse HEAD and the base. It
   names the PR when one exists; else it says that none exists yet. It says
   to read commits with git show and never check out, to change no file, and
   to send the full report to its parent and then call cezar_done.
   Do not edit the worktree while the round runs. Register worker wait <id>
   and end your turn. One round has a total time limit of one hour, counted
   from the spawn; the limit is this brief's rule, not a Squawk timeout.
   Within it, register the wait again after a wake on a message or a
   deadline, with a --timeout-seconds of at most the time left. When the
   hour has passed and the reviewer has not settled: run worker stop <id>,
   then worker destroy <id>, and count a failed round.
   A round is valid only when all three hold: worker collect <id> says
   settled true and partial false; the reviewer's full report has arrived as
   a message (the collected summary is not the report); and changes says
   unchanged. A reviewer that failed, was cancelled, or settled with no
   report, and a round with changes changed or unavailable, is a failed
   round: run worker destroy <id> and run the round again.
   Run worker destroy <id> before every next spawn: you may have one
   outstanding worker.
   A finding scored 5 or more: fix it, commit, and run one round on the fix
   only. Findings scored 4 or lower do not block; list them in the PR body
   (.ai/skills/auto-merge/SKILL.md § Arm it only after the review).
   When the spawn is refused (workers off for the task, the limit, a runner
   that is not available) or after two failed rounds: run the same prompt in a
   native subagent of your runner, and say in the PR body that the round ran
   that way. worker spawn --help lists the flags; docs/workers.md § Run a
   review round from a worker has the commands and the detail.
9. Release request: git rev-parse HEAD must still print the head SHA that
   the round's task named; else run the round on the new commits. Send the
   coordinator that SHA, the round's result and the readiness evidence. Push
   and open the PR only after its reply for that head (PR-opening gate above).
Read auto-merge before opening the PR. The campaign's owner-merge control
requires owner review; leave automatic merging off in that case. Workers
leave the merge action to the coordinator/owner under the recorded authority.
Repeat the steps after any later code change; step 8 then covers the new
commits only. Leave full suites to Squeal and CI. Commit attribution follows
your runner's own prompt; this brief adds none.

PR, after the coordinator's release: git push, then gh pr create --base main
(ready, not draft). Title in Conventional Commits, for example
refactor(<area>): <what moved>. Write the body in
.ai/qa/<N>/pr-body.md with: Closes hearsay-tools/cezarion#<N>; Summary (at most
3 sentences); Changed names (against the issue's list, and the reason for every
extra); Seams kept (each with the test that needs it); Orders preserved (for any
non-verbatim change); Verification (command and result lines); Left undone (or
"Nothing"); Review round (the reviewed head, how the round ran, and each
finding that does not block); Merge authority (copy the authority above).

After the PR: send the coordinator a progress message (PR, head SHA, changed
names, length pins, out-of-scope findings) and register one PR wait. Fix a red
check that your change caused, repeat the checks and push. Report a red check
you did not cause and wait. Fix in-scope review threads; answer the others with
a reason. Rebase onto origin/main only when the coordinator says so, then push
with --force-with-lease. When the required checks are green and no thread is
open, send the same progress message and finish the worker with cezar_done.

The coordinator owns landing, board and label changes, issue comments and
friction posts. Do not change the PR's draft state. Put each friction
finding in your final message as one line. Print config keys and paths only,
never their values.
Keep your branch: stay on cez/<your 8-char id>, and keep your handoff current.
At the end: git checkout cez/<your 8-char id>; squeal stop in this worktree;
.ai/scripts/test-env-down.sh when .ai/qa/test-env.json exists.
```

## Kind: move or refactor

```text
6. Move code verbatim: same bodies, same comments, same order. Keep every
   delegator, getter and manager-routed call that the issue names, because tests
   spy on or wrap them. Reach module internals in tests through the existing
   internals testkit; a `as unknown as` cast to reach private members breaks
   silently on the next move.
   For a risky PR (one that splits or merges functions, changes call order,
   shares code between two paths, or changes tests), CI's Vitest shards give
   the parity results. To debug a parity failure, run squeal run run-loop
   <paths> --wait 60000.
   Say in Verification which case applies.
   A changed or added test or guard needs the regression proof in
   docs/sdlc/regression-proof.md; record the command in the PR body.
```

## Kind: complexity split

```text
6. Bring each named function to complexity 20 or less and CRAP 30 or less, and
   keep the side-effect order of every branch. List each extracted helper with
   its measured complexity in the PR body. When a split changes call order, list
   the old and new order and run the parity suites as for a risky refactor.
```

## Kind: flaky test

```text
6. Start from evidence: the failure bundle under .ai/qa/failures/ or a local
   reproduction. Fix the test's wait or fixture, and keep every assertion and
   its timeout bound. Prove it: the reproduction fails on the pre-fix commit and
   passes on yours (docs/sdlc/regression-proof.md). Put the evidence in the PR
   body in the form of packages/web/e2e/README.md § The rules the ratchet
   enforces. Check the load average before any CPU burner and stop the burners
   after the run.
```

## Kind: mutation

```text
6. Start each measurement with the job start command that the cezar_wait
   tool description names, and wait for it with a process wait; never with
   &, nohup or a background tool.
   Start the baseline measurement with --out <baseline.json>. While it runs,
   write tests from the issue's FAIL lines; do not wait idle for the baseline.
   mutants-file.cjs measures the committed HEAD: commit the tests before the
   final measurement. Start the final run with --out <final.json> independently
   of the baseline. Runs on one host queue: the later run prints its position
   and starts when the earlier one ends; take no lock of your own. Once both
   finish, run:
   node .github/scripts/mutants-file.cjs --compare-results <baseline.json> <final.json>
   Cite the final result's PASS lines and the measured HEAD in the PR.
   Progress appears every 30 seconds; an unknown count means preparation or
   the initial test run has not produced a mutation plan yet.
   To recount saved outcomes with current counting, targets and equivalents:
   node .github/scripts/mutants-file.cjs --rescore <final.json> --out <rescored.json>
   Rescore requires scoring evidence from the current command; older stored
   results remain comparable but need a new measurement for exact rescoring.
   A rescore does not rerun tests or prove the current HEAD passes.
   Rescore a result made before a targets.json or equivalent.json change
   before you read any guard from it.
   If the initial test run times out, add --dry-run-timeout-minutes <n>.
```
