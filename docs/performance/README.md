# Performance measurements

This directory holds measurement reports and their raw data. Read the method rules below before you
measure a change or write a CPU or timing claim in a pull request.

## Reports

| Report | What it measures |
| --- | --- |
| [Browser tab coordination](browser-tab-coordination.md) | HTTP/1.1 connections and live traffic per tab group (hearsay-tools/cezarion#924) |
| [Workspace stream summary events](workspace-summary-events.md) | Workspace stream bytes, frames and parse time (hearsay-tools/cezarion#2730) |
| [Runs index patched from the stream](runs-index-patching.md) | Index reads, React commit time and renderer time (hearsay-tools/cezarion#2729) |

## Method rules

These rules come from runs that measured the wrong thing or measured noise
(hearsay-tools/squawk#4238).

1. **Fixed targets that the measured view renders.** Pick the rows, runs or files that a workload
   changes by a fixed rule, and check that the view under measurement shows them. Never pick them
   from `listRunIds()` or another unordered list: one round renamed an archived row in about half
   of its runs, and the view did not render that row.
2. **The `console.timeStamp` shim for React profiling builds.** React 19.2's profiling build writes
   a Performance-panel track for every component of every commit. That track is profiler cost, and
   it dominated renderer time on both sides. The harness shim removes `console.timeStamp`; see
   [`vite.profiling.config.ts`](../../packages/web/scripts/vite.profiling.config.ts) and
   [Method and evidence](runs-index-patching.md#method-and-evidence).
3. **Alternate before and after in one session, and report medians.** Run base 1, candidate 1,
   base 2, candidate 2, and so on, at least 5 rounds. Report each side's median and its range. One
   before run and one after run on a shared host differ by seconds of CPU when the load changes
   between them.
4. **Record the load next to every run.** Write the 1-minute load and the core count beside each
   run, and say how much they changed. Deterministic counts (bytes, frames, requests) need no load
   ceiling. Timing numbers do.
5. **A CPU claim needs a quiet host.** A user-CPU claim is evidence only when the median 1-minute
   load is below half the core count. Above that ceiling, report a measure that load does not
   move, such as oxlint's per-rule `--debug timings` time. For lint, `profile-lint.ts --compare`
   applies rules 3 to 5; see [Add a rule](../sdlc/lint.md#add-a-rule).
