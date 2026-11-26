# Regression proofs

[Changing working behavior](../../CODE_REVIEW.md#changing-working-behavior) says when a
regression test needs proof that it fails without the fix. This page says how to get it.

Every proof runs through `squeal proof`. It runs the red side and the green side in its own
temporary checkout, reads a side from Squeal's store when a result exists, and tells an
assertion failure apart from an import or setup error. The task's work tree, its index and
the stash stay untouched, so no test runner runs by hand in a Squeal-watched worktree
(AGENTS.md § Validation). `squeal proof` reads committed `HEAD`: commit the test and the
fix first. It covers Vitest server and web tests, node:test files and browser specs. Run
`squeal --help` for every flag.

A proof's evidence is the red line, the green line and the task-worktree Squeal verdict of
the same test file (`squeal status --json <test file>`, `.selection.testFiles`). Put all
three in one place: the PR body, or the one reply that answers a review thread.

## Source fix

Run the new regression test over the code from before the fix:

```bash
squeal proof packages/cezar/src/path/to/regression.test.ts --base <commit before the fix>
```

Red is the test at `HEAD` over the code at `--base`. Green is the test and the code at
`HEAD`. The verdict must be `proven`, with a red failure that shows the reported defect.
`red for another reason` (an import or setup error) and `not comparable` are not proof.

When the test is unchanged since `--base`, Squeal compares nothing until every other file
changed since `--base` is named. Imported files, files the test reads at runtime (through
`readFileSync` or `git ls-files`) and scripts it spawns count the same. Without the names,
the verdict is `not comparable`, with the reason `changed files not named: <paths>`. Name
every path that reason lists with `--source <path>`.

A new test that imports an export the fix adds cannot run over the code from before the
fix: the import fails, and the verdict is `red for another reason`. Prove such a test with
a [named break on `HEAD`](#a-named-break-on-head) that undoes the fix's behavior and
keeps the export.

A browser spec usually fails by a wait that times out, not by an assertion, so its red side
reads `red for another reason` even when the break caused it. Such a side counts as red
only when its failure text names the broken behavior, for example
`predicate never became truthy: document.body.textContent.includes('Automations are off')`
for a break that renames that title. An error in setup, the build or the browser launch is
not proof. Squeal stores no green side for a red it cannot judge: read the green
verdict from the task worktree (`squeal run browser <spec> --wait 60000`).

### A fix that spans several commits

When the fix for one thread or issue spans several commits, prove each fixed case on its
own. Take as `--base` the parent of the commit that introduced the fix for that case, not
the parent of the first commit and not the merge base. A base that already holds an earlier
fix commit can turn a real proof into `not red` or hide one case behind another. Report
each case with its own red line, green line and Squeal verdict, in the same reply.

## A named break on `HEAD`

To prove that today's tests still catch an old bug, apply a named break to `HEAD` and
run the tests over it:

```bash
node scripts/regression-proof.mjs <recipe>
node scripts/regression-proof.mjs --revert <commit> --test <test file>...
node scripts/regression-proof.mjs --patch <file> --test <test file>...
```

The script builds the break as a commit object over `HEAD` (a temporary index, never
checked out), runs `squeal proof <tests> --base <break> --case source`, and prints each
file's verdict, its failing tests and `proven X/Y`. It names every file the break changes,
other than a named test, with `--source`. A break in a file the tests read at runtime or
spawn is therefore proven the same way as a break in an imported file. It also passes
`--env SQUAWK_REGRESSION_PROOF=1`. Under a condition, Squeal runs each side fresh and
stores no result, because a stored result never belongs to a break commit. Squeal also
runs the red side once without the condition, as a control. A file can take three runs,
so give `--timeout` room for them. Its exit code is Squeal's: 0 when
every file is proven. `--revert` reverts one non-merge commit on top of `HEAD` and stops
when the revert conflicts. `--patch` applies a patch that introduces the break.

A **recipe** is `scripts/regression-proofs/<name>.json`: a `description`, `fixedBy` (the
commit that fixed the bug), `break` (entries of `file`, `find` and `replace`, where `find`
occurs exactly once in the file) and `tests`. Check in a recipe for a bug that a parity
row, a contract row or another shared test must keep catching. `--list` names the
recipes; `--check` validates them at `HEAD`. `scripts/regression-proof.test.mjs` fails
any change that moves a recipe's break text or test file: update the recipe in that
change.

Cite a proof by its command and its `proven X/Y` line, beside the Squeal verdict.

## Mutant report instead of `squeal proof`

The **Mutation report** comment on a pull request can stand in for the **source fix** proof above,
and for no other proof. The job
([`mutation-report.yml`](../../.github/workflows/mutation-report.yml)) makes small edits to the lines
the pull request changes, called mutants, and runs the package's own unit tests against each one. A
mutant that makes a test fail is **killed**. It is advisory: it never blocks a merge, and it posts one
comment that each push updates. The job runs only while the pull request carries the `mutants` label:
add the label when you want the report as red proof. Without it the job is skipped; after the label
is removed, the comment stays as last posted.

A mutant that restores the behavior from before the fix can only be killed by a test the pull request
adds or changes, because every older test passed against the pre-fix code on `main`. A killed
mutant of that kind is the red proof, found by the job and not by hand.

The report stands in for the proof when all of these hold:

1. The comment names the commit you pushed, and the package that holds the fix shows no `Skipped`,
   `Stopped` or `Failed` line. A package is skipped above the limits in
   [`mutants-scope.cjs`](../../.github/scripts/mutants-scope.cjs), and when no test file of the
   package imports the changed files.
2. The fix and the regression test are in the same package. The job runs only that package's tests.
3. No mutant on the lines of the fix survived or was left `Not covered`. Each one that remains is
   named in the PR body with the reason it does not change behavior.
4. The collapsed list of killed mutants holds one on a line of the fix that restores the old
   behavior: a guard's condition replaced by its old value, the guarded block emptied, or the new
   operator swapped back. A `Timed out` mutant does not count, because a hang is not a failing test.

Cite the comment in the PR body: the commit, then the file, line and mutator of the killed mutant.

The report does **not** stand in when the fix is outside `packages/*/src` (scripts, workflows,
configuration, documents), when the change only deletes code or only edits a module-level constant
(the job skips static mutants), when the change is test-only or removes a hidden dependency, when the
test pins timing or load, or when no pull request exists yet. Use the matching proof then. To run
the job by hand, do it in a standalone scratch clone where Squeal does not run, because Stryker edits
files in place: `STRYKER_PROJECT=<package> pnpm exec stryker run --mutate 'packages/<package>/src/<file>.ts:<from>-<to>'`.
Never use a linked worktree for it: a mutant can run the real dependency in place of the injected
one, and from a linked worktree it reaches the live repository's refs and the cockpit that serves it
(hearsay-tools/cezarion#2367).

To measure a whole file, run:

```bash
node .github/scripts/mutants-file.cjs packages/<package>/src/<file>.ts \
  --out ~/.cache/cez/mutants/result.json
```

A whole-file run takes 20 minutes to 3 hours. In a Squawk task, start it with the `job start`
command that the `cezar_wait` tool description names, and wait for it with a process wait. A job
started with `&`, `nohup` or a runner's background tool can end with the shell call or the session.

The command creates and removes its own standalone checkout of `HEAD`, with no remote and no
`CEZ_*` variables, so Stryker never edits the worktree that Squeal validates and a mutant cannot reach
the live repository or cockpit. Contract files also run their direct server and web consumer tests; add
`--tests <test files>` for more contract consumers. The file's own package pass measures static
mutants (code that runs at import) and counts them; the consumer pass skips them. The command measures the committed HEAD, including committed tests, rather than uncommitted edits.
It prints phase changes and progress every 30 seconds: completed/total mutants and elapsed time.
Preparation and the initial test run show an unknown count until Stryker has a mutation plan.
Whole-file runs on one host run one at a time: a run waits in a queue under
`~/.cache/cez/mutants/queue` before its scratch checkout, prints its position when it changes, and
starts when the runs before it end. A run that was killed keeps its turn until the Stryker processes
it started have ended; then the next run removes its entry.
Stryker stops the initial test run after the `dryRunTimeoutMinutes` value in `stryker.config.json`
(25). For a file that many tests import, add `--dry-run-timeout-minutes <n>` (1 to 600) to raise it.
The summary lists the survivors and the Timeout mutants of each function with their lines.
It validates `--compare` inputs and the `--out` destination before creating the scratch checkout.
For measurement, the managed `~/.cache/cez/mutants` output parent is created when absent;
validation does not reserve the destination, so a later filesystem change can still make the write fail.
Use `--compare ~/.cache/cez/mutants/earlier.json` to compare runs of the same result version and file.

The baseline and final measurement can run independently. Save each with `--out`, then compare:

```bash
node .github/scripts/mutants-file.cjs --compare-results baseline.json final.json --out delta.json
node .github/scripts/mutants-file.cjs --rescore final.json --out rescored.json
```

These stored-result modes run no installs, builds, tests or mutants. Rescore applies the current
counting rules, targets and equivalent entries to the original outcomes and source evidence;
it preserves the measured HEAD and consumer failures and marks the output as rescored.
A result made before a change to `.github/mutants/targets.json` or `.github/mutants/equivalent.json` is
rescored with `--rescore` before any guard is read from it.
New version-2 results include the complete scoring evidence. Older results without that evidence
can still be compared, but rescore rejects them with a request to measure again. Rescore does not
prove that current tests pass. Without `--out`, stored modes print their result only. Output must
not alias either input, including through a symbolic or hard link.

The **Weekly mutation targets** workflow
([`mutants-weekly.yml`](../../.github/workflows/mutants-weekly.yml)) runs this command on `main` every
Saturday for each file in `.github/mutants/targets.json`, then for the product files with the most
lines changed in the last 7 days, at most 64 files in all. Its run summary lists the files over that
cap. It opens one issue per file that misses a target, `Mutation targets missed: <file>`. A fix PR
runs the whole-file command, cites its PASS lines and says `Fixes #N`.

Each entry in `.github/mutants/targets.json` declares a tier and a list of guard functions. Only a
declared tier has targets:

| Tier | Targets |
| --- | --- |
| `logic` | Counted score at least 85%, no not-covered line, and each guard |
| `component` | Counted score at least 75%, and each guard |
| `guards` | Each guard only. The list must name at least one guard. |

A guard target passes when the function exists in the file and has no undetected mutant, message
text included. Name a function as a guard when a wrong branch in it deletes or moves user data,
leaves a half-done migration, reports success for a failed step, widens exposure (firewall, proxy,
origin) or shows a wrong merge state. Do not name a function whose undetected mutants are mostly
argument lists or message text. A guard name must match exactly one function in the file: name a
class method as `Class.method`. An object-literal method, such as an install step's `check`, has no
unique name and cannot be a guard. The scripts refuse an unknown tier,
an empty guard name and a `guards` entry with no guard.

A changed file without an entry is a **candidate**. The weekly run measures it, but it has no target
and opens no issue: the run summary lists it under "Candidates" with its changed lines and counted
score. Give it a tier, or leave it out. The weekly run closes an open issue for a file without an
entry with a comment that states this rule. The whole-file command prints `Tier: none` for such a
file and no target lines. A contract file still prints its consumer-test PASS or FAIL line.

## Test-only fix

For a **test-only fix**, run the old test over the current code, repeated as often as
the defect needs to show:

```bash
squeal proof packages/cezar/src/path/to/test.test.ts --base <commit before the fix> --case test --repeat 20
```

Red is the test at `--base` over the code at `HEAD`. A load-related failure needs its
original load or a controlled reproduction. An ordinary passing red side is not proof.

## Test-only change that removes a hidden dependency

A **test-only change that removes a hidden dependency** needs this proof even when no
failure has been observed. This includes dependence on a catalog, a host setting or a
default the test did not write. Name the dependency as a condition on both sides:

```bash
squeal proof <test file> --base <commit before the fix> --case dependency \
  --without <path> --env NAME=
```

`--without` hides a path in the repository or under `HOME` (with `--home-keep` for files
the run still needs). `--env NAME=` unsets a variable, and `--env NAME=value` sets one. The
old test must fail for that reason, and the new test must pass under the same conditions.
Cite the evidence in the PR body, in the
[E2E form](../../packages/web/e2e/README.md#the-rules-the-ratchet-enforces); for
non-browser tests, cite the runner output instead of a bundle.
