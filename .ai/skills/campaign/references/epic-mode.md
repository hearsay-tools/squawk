# Epic mode

The planner owns the epic's approved plan, phase dependencies and phase exits.
Each phase runs the campaign loop in its own coordinator task. This separates
planning from day-to-day worker supervision. Product decisions stay with the
owner; the planner relays decisions and coordinates their effect on the plan.

## Before the first phase

1. Read the epic, relevant specs/ADRs and current main. Explore with governed
   read-only workers when useful, including cross-cutting constraints.
2. Use the repo's planning skills to resolve missing design. For features,
   follow [feature readiness](feature-delivery.md#readiness); for cleanup,
   confirm [the neutral contract](cleanup-worker-brief.md). Record the plan in
   `.ai/specs/`, with an ADR when required. Get the owner's approval for a new
   plan; use an existing approved plan after checking its freshness.
3. For each phase, name the slices, dependencies, preserved guarantees, checks,
   evidence owner and exit on integrated main. Each intermediate main must
   remain usable at shipped defaults. Resolve dependency cycles before dispatch.
4. Find each structural criterion: an epic criterion that claims a property of
   a whole set or of the whole repository ("only", "every", "all", "no"). No
   slice diff or diff-scoped review can show that one holds. For each, name an
   executable check (a script or test and its command) and put it in the first
   slice of Phase 1. If main does not pass it yet, the check records a
   known-gap list; name where the list lives. A structural criterion without
   an executable check is not ready: rewrite it with the owner before approval.
5. File the epic/sub-issues when needed under the repo's issue-authoring rules.
   Have a governed worker publish the approved spec as a docs PR and review it
   before land-pr. Keep the planner checkout aligned with main so later
   fast-forwards work after squash merges. Land the spec before implementation.

Done when the current approved spec is merged, every phase has a checkable
exit and every structural criterion has an executable check in Phase 1. Design approval does not grant merge authority.

## Each phase

1. **Draft.** Prepare issue drafts from the spec: work type, done line, scope,
   expected regions, contracts and prerequisite release checks. Drafting can
   overlap the preceding phase.
2. **Verify.** After prerequisites are accepted on main, have a governed
   read-only worker check every draft against that code and the approved plan.
   Collect its latest result and apply corrections. Changed product scope
   returns to the owner before filing or dispatch.
3. **File.** File the verified issues as epic sub-issues, with board and labels.
   Update the phase's dependency/wave table. Land material plan updates before
   affected implementation starts.
4. **Start.** Start a phase coordinator as a root Squawk task with the prompt
   below and a freshly discovered runner/model/effort. Use `hsq task start`
   with `--task-file <prompt>` and the selected execution controls. A worker
   may start only one shared-workspace worker at a time; a phase coordinator
   needs a root task's rights.
5. **Wait.** Keep one long peer wait per active coordinator: register
   `hsq message wait --peer <coordinator id> --timeout-seconds 7200`, rather
   than renewing 30-minute waits. Put the request deadline in the first line
   of each coordinator request and set its matching `--timeout-seconds`. Answer from
   approved decisions; route new product questions to the owner. Prepare the
   next phase while this one runs, then repeat its verification against main.
6. **Accept.** Read the coordinator's report and recheck the phase exit on main.
   Record SHA, acceptance evidence, metrics when relevant and scope changes in
   the epic body. Shared notes keep only lessons absent from the repo, under
   their own rules. A merged issue list alone does not pass a feature phase.
7. **Run structural checks.** At every phase exit, run each structural check
   on main and record its output with the phase evidence. A gap missing from
   the known-gap list fails the exit: it needs a repair. Before the next phase
   starts, give each remaining gap a slice in a named later phase. The last
   phase exit needs an empty gap list.

Done when the phase exit holds on main and its evidence is recorded. Continue
without asking for routine scheduling decisions. An unreachable exit needs a
repair or owner-approved plan change. Close the epic only after every required
phase is accepted and owned workers are collected and destroyed.

## Coordinator prompt

```text
/campaign in batch mode: coordinate one phase.

Epic <repository-qualified issue>, Phase <N>: <explicit issue list>.
Approved spec: <path and revision>; read <sections> first.
Work types: <per-issue cleanup or feature>.
Prerequisites accepted on main <SHA>: <conditions and evidence>.
Phase exit: <integrated checks, evidence owner and acceptance criteria>.
Structural checks: <per criterion: command and known-gap list; run each on
main at the phase exit and report new and remaining gaps, or none>.

Controls: <worker model policy or runner/model/effort>, at most <k> live workers, hot-file control
<value>. Merge authority: <owner's explicit grant and source, or "The owner
merges each PR">. Product decisions stay with the owner.
Phase exceptions: <owner-approved exceptions and dates, or none>.
Previous handoff/state: <paths, if present>.

Planner task: <id>. Report with hsq message progress when the phase is
accepted: merged PRs, main SHA, exit evidence, metrics, scope changes,
exclusions, blockers and friction. Route product questions as explicit
requests to the planner. Put the request deadline in the first line and set
its matching --timeout-seconds (up to 7200); acceptance of a message is not a
decision reply.
```
