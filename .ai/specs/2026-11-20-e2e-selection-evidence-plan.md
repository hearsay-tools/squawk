# Browser spec selection from complete evidence
Status: active

## Goal

PR CI runs a strict subset of the cockpit browser specs for most PRs that touch code a spec
reaches. Today it never does. The selector chooses every spec, and PR CI then runs none
(`browserFiles` in `scripts/ci-test-selection.mjs`). This plan fixes the evidence the selector
reads, so that "every spec" is the answer only when the evidence really says so.

## Out of scope

- The PR policy for a full selection. A full selection still runs no spec on the PR, and the
  merge queue still runs every spec (owner decision, 2026-11-20).
- Narrowing the static rules by hand: type-only imports in the setup scan, the duration JSON
  files, extra `NO_SPEC` rows. Slice 3 makes most of these unnecessary for code files. Files
  that are not code keep their current rules.
- Cockpit (`packages/web/src`) selection. It already works per file.

## Evidence

These numbers come from the shard 1 log of 57 PR CI runs on 2026-11-19 and 2026-11-20 (cancelled
runs left out):

| Selection | Runs |
| --- | --- |
| Every spec (skipped) | 42 |
| No spec (skipped, correct) | 15 |
| Strict subset (ran) | 0 |

Why the 42 runs needed every spec:

| Cause | Runs | Slice that removes it |
| --- | --- | --- |
| Server or CLI file with no function evidence | 15 | 3 |
| The setup scan reaches the file | 8 | 3, for code files |
| `.ai/scripts/*` blanket rule | 6 | 3 |
| Changed lines outside every recorded range | 5 | 2 |
| The changed function really runs in every spec | 5 | none (correct) |
| Root `scripts/*` path the map does not cover | 3 | 3 |

There is a hidden second blocker. The capture credits the shared server's startup snapshot
(`shared-startup-*.json`) to every spec. In the map at `dc70d355`, 560 of 624 server files have a
top-level range that all 97 specs "ran". A change to module-level code therefore selects all 97
specs. So does any drift file on `main` that changed such code. A one-line edit in
`packages/web/src/components/mobile-tab-bar.tsx` selects 97 of 97 specs today, through drift in
`ci-wait/tool-catalog.ts` and `server/activity-routes.ts`.

The map also does not always come from the right commit. `latestMap` takes the newest successful
run on `main`. When that run is newer than the branch's fork point, `git diff <map> <fork>`
reports `main`'s later changes as drift, and the map's line numbers do not match the branch.

## Plan

### Slice 1: the map for the fork point (selector only)

- `latestMap` reads `headSha` from `gh run list` and picks the newest successful run whose head
  is the fork point or an ancestor of it (`git merge-base --is-ancestor`). It never picks a map
  newer than the fork point.
- The fork point is computed before the map is loaded.
- No map at or before the fork point: the cached-map rules apply, then every spec, as today.

### Slice 2: startup evidence kept apart (capture, map, selector)

- `build-map.ts` stops merging `shared-startup-*.json` into each spec's function evidence. A
  function entry gets `specs` from the per-spec snapshots only, and `startup: true` when the
  shared startup ran it.
- The map version becomes 2. The selector reads only version 2. A version 1 map counts as no
  map: every spec runs until the first version 2 map is built on `main`.
- The selector takes the innermost recorded range that encloses each changed line, as today.
  - An entry with `startup: true` adds the **boot spec** to its own specs.
  - A changed line in a file with function evidence, but outside every recorded range (imports
    above the first mapped line, lines after the last one), counts as top-level code. It selects
    the boot spec plus every spec that ran any function of that file.
- The **boot spec** is the shortest passing spec with complete evidence, by
  `.github/cockpit-test-durations.json`. Every spec boots the shared server, so the shortest one
  is enough to show that the server still starts.
- Drift uses the same rules. A startup-only drift edit adds only the boot spec.

### Slice 3: coverage of every process the suite starts (capture, map, selector)

- The capture records coverage, with its owning spec, for every Node process and worker thread
  the suite starts:
  - CLI and other children the shared server or a mock starts, not only `mock-*.mjs` children;
  - worker threads, such as the transcript-facts worker, including source `.ts` entries run
    through `tsx`;
  - the Vitest process: setup files and the spec files' Node helpers, with setup evidence kept
    apart from per-spec evidence.
- `scriptFunctions` keeps every repository code file, not only `dist/` server files and mocks.
- The map lists every repository code file that any process loaded (`loaded`), and the roots
  whose processes the capture covers (`covered`).
- The selector gets a new rule. A code file under a covered root that exists at the map's commit
  and that no process loaded selects **no spec**: "no process the suite starts loads it". Today
  it selects every spec.
- Vitest-side setup code follows the slice 2 rules. Setup functions that ran select every spec,
  and top-level setup code selects the boot spec.
- The static setup scan and the `.ai/scripts/` and root `scripts/` rules remain only for files
  that are not code (JSON, shell, PowerShell).

## Case tables

### Changed server or setup code (slices 2 and 3)

| Case | Today | After |
| --- | --- | --- |
| Line inside a function that some specs ran | Those specs | Those specs (no change) |
| Line inside a function that only startup ran | All 97 (startup credited to all) | Boot spec |
| Line inside a function that ran at startup and in some specs | All 97 | Boot spec + those specs |
| Line inside a function that no spec ran | No spec | No spec (no change) |
| Import or top-level line outside every recorded range | Every spec | Boot spec + specs that ran any function of the file |
| File no process loaded, existed at the map commit | Every spec | No spec |
| New code file, absent at the map commit | Every spec | Every spec (no evidence; the file may be loaded through a computed path) |
| Vitest setup function that ran | Every spec (static scan) | Every spec |
| Vitest setup module that the static scan reaches but no process loaded (for example a type-only import) | Every spec | No spec |
| Non-code file that the setup scan reaches (JSON, shell) | Every spec | Every spec (no change) |

### Map selection (slice 1)

| Case | Today | After |
| --- | --- | --- |
| Map commit = fork point | That map, no drift | Same |
| Map commit older than the fork point | Newest map, drift = commits since it | Newest map at or before the fork point; same drift |
| Newest map newer than the fork point | That map; main's later edits count as drift | The newest map at or before the fork point |
| No successful map at or before the fork point in the last 20 runs | The newest map | Cached map at or before the fork point, else every spec |
| `gh` unavailable | Newest cached map | Newest cached map at or before the fork point, else every spec |

## Done when

- Outcome: replaying the selector over the diffs of the last 57 PR CI runs, with the first
  version 2 map that the PR's `E2E spec map` run builds, gives a strict subset for most runs that
  today select every spec, and still gives every spec for the 5 `run-states.ts` runs.
- Proof: the replay table in the PR body (per run: before, after, reason) and unit tests in
  `scripts/e2e-affected.test.*` and `packages/web/e2e/spec-map/*.test.*` for each case row above.
- Failure: a new code file, or a non-code file that the setup scan reaches, still selects every
  spec. A version 1 map still counts as no map.

## Delivery

Three PRs in slice order, each green on its own. Slices 2 and 3 change `packages/web/e2e/spec-map/**`,
so the `E2E spec map` workflow runs on the PR and builds the map the replay uses.
