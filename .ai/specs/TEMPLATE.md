# <Feature name>
Status: draft

<!--
Use `Status: draft`, `Status: active`, `Status: done` or `Status: superseded`
directly under the first heading. If a successor exists, use
`Status: superseded by <file>.md` with its spec filename.
A draft has no approved implementation in progress; active work still binds;
done work has shipped; superseded work has been replaced.
Delete a `-plan.md` file when its work is merged or superseded, and fix every link to it.
Git history keeps the finished plan. Keep other specs as design records.
-->

## Goal

## Out of scope

<!-- What this work does not change, and where that work goes instead: an issue or a later slice. -->

## Done when

<!--
Three lines. A reviewer checks each one against the diff:
- Outcome: what a user or caller sees when the work is done.
- Proof: the test, command output or screenshot that shows it.
- Failure: one case that must still fail or be refused, and how that shows.
-->

## Evidence

## Plan

## Case tables

For the changes below, the spec or plan must carry the applicable case table,
reviewed before implementation. Use one row per case, cover every required case,
show behavior at shipped defaults, and state impossible cases with their reason.

| Change | Table and columns | Required cases |
| --- | --- | --- |
| Adds or changes a cross-run relationship: messaging, delegation or settlement notification | **Both ends**, each state at each end: State · Send path behavior · Settlement path behavior | queued, running, waiting, Finish pending, stopping, review, done, failed, cancelled, deleted, history deletion pending, restart, other process owns it, unreadable record. |
| Adds or changes a run state, or changes how a run leaves an existing state (an exit trigger or recovery path) | **Transitions out**, based on `RUN_EXITS` in `packages/cezar/src/runs/run-exits.ts` ([ADR 0056](../../docs/adr/0056-let-the-run-store-own-run-exits.md)); triggers in `packages/cezar/src/workflows/run-states.ts`: State · Trigger · Who or what fires it · Behavior at shipped defaults | Each non-final state; its automatic exits or recorded human-only reason (`packages/cezar/src/workflows/run-states.test.ts`). |
| Holds, parks or resumes a run, or changes how a held or parked run resumes: a hold, a park reason, a Continue or an automatic retry | **Resume cases**, based on the `parkReason` and `workflowCursor` facts ([ADR 0064](../../docs/adr/0064-record-run-lifecycle-facts.md)): Case · What resumes it, and the step, session and runner it resumes · Behavior at shipped defaults | A queued continuation across a restart; a continuation with no session; a mixed-runner workflow step; a multi-step workflow resumed mid-way; a human Continue racing the automatic one. A change to how the run leaves a state also needs **Transitions out**. |
| Adds or changes a lock, lease, claim or ownership check on a shared resource, such as a run family, a checkout, a branch or a home file | **Lock and ownership cases** ([ADR 0006](../../docs/adr/0006-fence-run-family-ownership.md), [ADR 0062](../../docs/adr/0062-one-module-decides-run-checkout-access.md)): Path · Locks or claims taken, in order · Owner check and its result for a missing or unreadable record | The lock acquisition order on every path that takes more than one; what a missing or unreadable record defaults to; every gate keyed by a run id that guards a shared resource, and which run's id keys it. |
| Changes how a `ToolGrant` (`packages/cezar/src/core/agent-runner.ts`) maps onto a runner's tool flags | **Tool-list kinds**, one per affected runner: Case · Emitted runner flags · Callable built-in, MCP and extension tools at shipped defaults | Every case in `TOOL_GRANT_CASES` (`packages/cezar/src/core/tool-grant-parity-cells.testkit.ts`); its cells pin each case on each runner. Show effective tool access, not only the flags sent, and say when a runner ignores a restriction or cannot distinguish two cases. |
| Adds, replaces or removes files in a running task's worktree (`worktree-write-outside-manifest`) | **Worktree cases**: Case · Files written, kept or removed · Worktree state at the next step, Continue and restart | A catalog or source that has not loaded yet; the same name from two sources; records written by an older cezar version; a crash between two writes; the source removing the item; a FIFO, socket or other non-regular file in place of an entry; an agent write, delete, `chmod` or file-type change on the path while a pass stages or removes it; two different trees that share one identity. |
| Starts a process that outlives the command that started it (`detached-spawn-outside-helper`) | **Process exits**: Case · What stops it · Behavior at shipped defaults | The normal stop; the starting command interrupted by SIGINT or SIGKILL before and after the start; the handle the stop reads, such as a descriptor, deleted or forged. Who owns the process's name or resource: the long-lived process claims it in one write transaction of a store the OS unlocks when the owner dies (`node:sqlite`); a spec does not add a hand-built lock file with takeover rules. The helper's tests hold the rest: the leader exits first, a member ignores SIGTERM, zombies, an unreadable or reused start identity. |
| A spec or plan that deletes or retires rule text: in a skill, AGENTS.md, CODE_REVIEW.md, an area doc, an ADR or an active spec | **Removed rule text**: Paragraph · Moved to / Enforced by / Duplicate of / Dropped because | Every deleted or retired paragraph, one row each, with exactly one disposition. A table that lists only the surviving rules is incomplete. |
| Restores saved client state for an entity | **State restore cases**: Path or trigger · Restored value · Displayed value | Reopen without a selection; switch between two restored entities; entity unavailable after restore; derived display differs from saved state (e.g. provider mask). Derive from one state; never mask in a provider. |

The phase tables in [the unified-waits spec](2026-10-17-unified-waits.md#transitions-out-phase-2a)
show the form. The tables make cases explicit; they do not decide which cases share a policy.

A record that a later automation or prompt run reads is a cross-run relationship,
even when it is a Markdown comment. Identify its writer and authority, when it is
final, how older formats are read, and where the reader searches. Include an
unfinished record, a record from another writer, an older format and an absent or
unreadable record in the applicable cases. A table exposes the decisions; it does
not enforce a record protocol implemented only in prompt text.
