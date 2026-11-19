# Bundled tool

The scripts in `scripts/` serve the local pre-PR check and CI. They do not
measure requested code: for that, use [Measure requested code](measure.md),
which uses Squeal.

| Script | What uses it |
| --- | --- |
| `complexity-gate.mjs` | [Before a PR](pre-pr.md) and the `complexity-gate` CI job; `docs/sdlc/ci.md` § Checking function complexity and file length |
| `crap-report.mjs` | The `crap-report` CI job; `docs/sdlc/ci.md` § CRAP report for changed functions |
| `changed-functions.mjs`, `code-metrics.mjs` | `complexity-gate.mjs` and `crap-report.mjs`: the changed-function scan and the complexity counter |
| `istanbul-merge.mjs` | `.github/scripts/merge-vitest-coverage.mjs`, which merges the Vitest shards' coverage in CI |

The scripts require Node 24.15 or newer and Git. `istanbul-merge.mjs` needs only
Node. The counter needs `@babel/parser`, which resolves from the skill or an
ancestor's `node_modules`. If it is absent, install the bundled manifest:

```sh
npm install --prefix <skill> --ignore-scripts --no-audit --no-fund
```

## Tests

Each script's tests sit beside it in `scripts/`, named `<script>.test.mjs`. A
change to a script updates its tests in the same change. The tests use
`node:test`. Run them from the skill or any directory:

```sh
node --test <skill>/scripts/*.test.mjs
```

## Complexity counting

Complexity uses ESLint's classic convention: one, plus one for each decision
point in the function's own body. A nested function counts its own points.

The change scanner compares function source, excluding nested bodies from the
parent. Comments and whitespace inside a function count as edits. A function
moved or renamed without edits is not a change: the scanner lists it under
`moved` with the function it came from, and not under `files`. Its origin is a
removed function with an identical body and equal complexity, or one whose same-named successor in
the old place now stays at or under complexity 20, such as a delegator. A
function moved with edits appears as added. Duplicate identities can have an
unknown baseline. Inspect the diff and baseline for these cases before deciding origin.

## CRAP scoring

`crap-report.mjs` scores each changed function from an Istanbul
`coverage-final.json` with paths relative to the repository root, such as CI's
`vitest-coverage-<head SHA>` artifact. A function's coverage is the share of the
statements in its own body that ran; statements in a nested function count for
that function. CRAP is complexity² × (1 − coverage)³ + complexity, and the limit
is 30. Reproduce a CI report from a downloaded artifact:

```sh
gh run download <run id> -n vitest-coverage-<head SHA> -D /tmp/coverage
node <skill>/scripts/crap-report.mjs --base origin/main --head <tested SHA> \
  --coverage /tmp/coverage/coverage-final.json --exclude-config squeal.config.json
```

The tested SHA is the commit the shards ran: the pull request's merge commit,
or its head when CI reused it. A function whose file is not in the coverage
report has no coverage data and gets no score.

### Code that only a child process runs

Coverage is measured in the test's own process. A file that tests run only as a
separate process, or only as a copy at another path, has no measurable coverage.
The `coverage.exclude` list in `squeal.config.json` names these files. Both
`crap-report.mjs` and Squeal's measurement give a changed function in a listed
file complexity and no CRAP. The list holds:

- each native runner mock in `packages/cezar/scripts/` that tests start only as
  the runner's binary. The list names each mock: the mocks that tests import
  (`mock-controls`, `mock-lifecycle`, `mock-scenario`, `mock-publish`,
  `mock-session-context`, `mock-failure-control`, `mock-delivery-control`) keep
  their CRAP score, so a `mock-*.mjs` glob would be wrong.
- the manual probe scripts, `.ai/scripts/probe-*.ts`, which no test runs.
- `.ai/scripts/test-env-lease.mjs`, whose subcommands tests run only through a
  copy in a fixture checkout, because the script finds the repository root from
  its own location.

A new mock that tests start only as a child process goes into this list in the
same change, by name. Any other code that only a child process runs gets no
entry: export its functions and call them from a test in the test's own process.
Do not add an entry to hide one function's score.
