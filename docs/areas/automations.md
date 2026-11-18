# Automations (GitHub polls and schedules)

[AGENTS.md § Task routing](../../AGENTS.md#task-routing) points here. Read this page before you change or review this area.

## Read first

`packages/cezar/src/automations/`, then `packages/contract/src/automations.ts`, `packages/contract/src/automation-schedule.ts`, the automations family in `packages/cezar/src/server/server.ts`, `packages/web/src/routes/automations/`, and `.ai/specs/2026-10-02-scheduled-automations.md`

## Rules

On by default; only exact `HSQ_AUTOMATIONS=0` (`CEZ_AUTOMATIONS` fallback) opts out, and the gate middleware then answers `409`. Restart after changing the flag. New definitions remain paused; existing enabled definitions resume unless opted out. Two kinds: `github` polls, `schedule` fires on the clock and needs no remote. A schedule fire takes the hearsay-tools/cezarion#651 store lease, reserves one receipt per occurrence (`<id>:schedule:<iso>`), launches an ordinary task, and never advances `nextRunAt` on a lost lease. At most one catch-up inside 24 h, auto-pause after 3 consecutive launch failures. `setState` is a read-modify-write against a fresh disk read. No `task.dispatch`. Stage 2 (hearsay-tools/cezarion#774): `hsq automation` (`automations/automation-cli.ts`) reaches the cockpit through `HSQ_COCKPIT_URL` (`CEZ_COCKPIT_URL` fallback)/`HSQ_PROJECT_ID` (`CEZ_PROJECT_ID` fallback), which the boot manager receives at construction (`serve` binds its listener before it recovers, so recovered runs carry it) and every other project's manager receives from `startServer` via `RunManager.setCockpitAddress`; it never starts a server or probes ports on its own. The prompt part uses `automationsPart()` and the effective `HSQ_AUTOMATIONS` value (`CEZ_AUTOMATIONS` fallback) plus the cockpit address; new session construction sites use that helper. `cezar_automation` replaces the built-in automation skill. Templates, calendars and stats are stage 3.

## Agent tool

`cezar_automation` creates, shows, previews and enables repeating automations through
`automations/tool-adapter.ts`. The tool is offered behind `automationsToolEnabled`,
the same gate as the one-time schedule tools. Creation always stays paused and
refuses enable fields. Enabling requires `explicit: true`, which the agent supplies
only for the user's explicit request. A GitHub poll also needs a successful preview
of its current revision in that capability's session. Continue and recovery get new
capabilities and must preview again. Preview calls the existing scheduler without a
launcher; it cannot create tasks, reserve receipts or move the execution cursor.
The answer includes the cockpit URL when reachable, and a repeating schedule's next
occurrence in UTC even while paused. The one-time tools still see only one-time
schedules. The CLI remains available; there is no built-in automation skill.

The preview deadline includes admission and the shared GitHub request queue. It
allows two bounded poll scans for a canonical-name retry, plus one GitHub command
budget for discovery and queueing. The private client allows one more command
budget so the server can return its timeout diagnostic. An expired preview cannot
authorize enable, even if the provider later answers.

## Repository name and failing polls

A GitHub poll reads under the canonical `owner/name` that `gh repo view
github.com/<origin owner>/<origin name>` reports (`automations/github-repository.ts`),
not the `origin` URL text, because the issue search answers `422` for a renamed
repository's old name. It names `origin` explicitly: an unqualified `gh repo view`
picks gh's default repository, which is `upstream` in a fork. The name is memoized
per project (`server/forge/github-repo-handle.ts`). A `404` or `422` forgets it,
resolves again, and retries once, with a fresh acceptor, when the name changed.
Receipts match without the repository name (issues by node ID, pull requests by
the rest of the event ID), so a rename does not relaunch an old item.

A failed check stores `lastError` and `lastErrorAt`; a success or a re-arm clears
them, and a backed-off skip keeps the last real error. From
`AUTOMATION_FAILURE_NOTICE_AFTER` (3) consecutive failures, `automationFailureNotice`
gives the cockpit card's alert and the `failing` key of `hsq automation list`.

A GitHub rate limit is a pause, not a failure. The poller's requests go through the
shared GitHub request gate (see [GitHub integration § One request gate for the
pollers](github.md#one-request-gate-for-the-pollers)). During a pause the gate refuses a
check at once. The check logs `rate-limited` and moves `nextCheckAt` to the end of the
pause. It adds no failure count, no `backoffUntil` and no `lastError`.

## Project directory log reads

Both log sources and both receipt sources merge through `mergeAppendOnly`
(`merged-streams.ts`): a duplicate key (automation and sequence for log rows;
receipt, status and update time for receipts) keeps the legacy row, then the
survivors replay in recorded time (`ts`, `updatedAt`), so the latest receipt and
the newest log row are the newest events whichever directory holds them. With
both log sources present, a page read numbers the merged rows 1..n in that order
and uses that number as the positive cursor; a later append (newest time, highest
raw sequence) only extends it, so existing cursors stay stable. Compaction that
drops the oldest legacy rows can shift merged cursors down, which repeats rows on
an open page but never skips one. Legacy-only pages keep their stored sequences.
The projection is read-only: appends and compaction retain original positive
legacy sequences. Compaction rewrites legacy receipts and logs only. Fallback
records remain readable from their source and are never copied by compaction.

Log compaction retains the newest 10,000 legacy rows plus durable retry rows.
`AutomationStoreOptions.logRetentionCount` is a test-only override so paging
regressions can cross the compaction boundary with small fixtures.

## Project moves at startup

The boot context resolves its automation store when used. It must not retain a
store opened before automatic project preparation. The coordinator compares each
cached store's directory with `projectPaths(root).write`, both during refresh and
at lookup, and replaces a handle whose directory changed. Initial discovery and
late registration prepare projects before braking idle polls and arming schedules.
A busy project keeps its legacy write root and its existing automation state.
Baselines, cursors, schedule state, receipts and logs follow the same write root.
