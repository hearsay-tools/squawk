# Before a PR

Run the complexity gate on the committed head. It is the only local quality
check before a PR. It reads no coverage, runs no tests and takes seconds.

## 1. Run the gate

Commit the change first: the gate reads the head from Git objects and ignores
the working tree. Fetch the PR target branch from the repository bindings, then
run from the repository root:

```sh
node .ai/skills/check-code-quality/scripts/complexity-gate.mjs --base origin/main --head HEAD
```

Replace `origin/main` when the PR targets another branch. CI's
`complexity-gate` job runs the same script on the pull request, so a local pass
predicts that job.

| Exit | Meaning | Action |
| --- | --- | --- |
| 0 | No changed function over complexity 20 is new or more complex than at the merge base | Done |
| 1 | At least one function grew over 20 | Resolve each finding, commit, rerun |
| 2 | The gate could not run (bad revision, unparseable file) | Fix the cause and rerun |

The limit is complexity 20; equality passes. A function that stays over 20
without growing passes and is listed as a notice. A moved or renamed function
is compared with the function it came from. For the counting rules, see
[Bundled tool](tool.md#complexity-counting).

## 2. Resolve findings

Read each named function, its decision points and its tests. Lower its
complexity within the approved scope, then commit and rerun. If the fix needs
a larger design, report the blocker before opening the PR. Keep decisions
visible rather than moving them to a helper merely to lower one score.

Only the owner approves growth, with the `baseline-growth` label in CI. An agent
never adds the label.

## 3. Record the result

In the PR's validation section, state the command and its result line, for
example `complexity-gate.mjs --base origin/main --head HEAD → Checked 12 changed
functions in 3 files in 0.4 s: none over 20 is new or more complex than at the
merge base.`

## CRAP is reported in CI

No local step measures CRAP before a merge. CI's `Report CRAP for changed
functions` job scores the changed functions from the pull request's Vitest
coverage. It never fails a check: its job summary lists each function, and a
function over CRAP 30 gets a warning. After the merge, each function over 30
gets a line in the open `crap-follow-up` issue. See `docs/sdlc/ci.md` § CRAP
report for changed functions.
