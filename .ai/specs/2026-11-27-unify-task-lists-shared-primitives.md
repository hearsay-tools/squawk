# Unify project, global, and mobile task lists on shared primitives
Status: active

## Goal

Unify Project Tasks, Global Tasks, and mobile task lists on one shared `<TaskTable />` component and one `TaskRowModel` projection, collapse page chrome to two tiers inside `<TablePage>`, add 1-line urgent/failed previews and an explicit per-row `Usage` telemetry trigger, and ship five shared data primitives (`<Sha />`, `<DiffStat />`, `<Count />`, `<RelativeTime />`, `<Path />`) backed by the `cez/use-data-primitives` oxlint rule (`hearsay-tools/squawk#4377`).

## Out of scope

- Immediate layout bugfixes for the Columns popover, Resource columns overflow, and Group by Project cards — tracked in `hearsay-tools/squawk#4382`.
- Live Activity (`packages/web/src/routes/activity/*`) — owned by `hearsay-tools/squawk#4376` running in parallel; disjoint file boundary.

## Done when

- Outcome: Project Tasks, Global Tasks, and mobile task cards render through `<TaskTable />` (`table`, `compact`, `card` densities) with two-tier `<TablePage>` chrome, Global Tasks supports pinning, column selection, Runner/Model metadata, automatic project badges, and origin + Project/Tag-scoped bulk actions, urgent/failed rows display a 1-line preview without `Direct task` clutter, and telemetry opens from an explicit `Usage` button plus toggleable `Usage` column.
- Proof: Contract, lint-rule, primitive, model, `<TaskTable />`, Project Tasks, and Global Tasks unit tests pass; `npm run typecheck`, `npm run lint`, and `npm run prepr` pass with zero findings.
- Failure: An unmigrated ad-hoc SHA slice (`sha.slice(0, 7)`) or direct JSX `shortAge(...)` render in `packages/web/src/` is refused by `cez/use-data-primitives` during `npm run lint`.

## Evidence

- Approved product decisions recorded in this session:
  1. Explicit per-row `Usage` trigger popover + toggleable `Usage` column; remove hidden click-on-status-pill disclosure and its footer hint.
  2. Leave `packages/web/src/routes/activity/*` untouched for `hearsay-tools/squawk#4376`.
  3. Global Tasks bulk actions (`Mark all read`, `Archive finished`) follow active origin plus selected Project or Tag filter (not search text or status/workflow facets).
  4. Remove `Direct task` row labels; show automation badges only on automation runs; show `Runner · Model` on meta line; show 1-line truncated preview on `Needs you` and failed rows.

## Plan

1. **Contract (`packages/contract/src/runs.ts`):** Add optional `statePreview` (`ask | permission | review | error`, 1-line normalized text) to `runSummarySchema` (inherited by `runIndexEntrySchema`) via `deriveRunStatePreview`.
2. **Data primitives + lint guard:** Add `<Sha />` (8 chars), `<DiffStat />`, `<Count />`, `<RelativeTime />`, and `<Path />` in `packages/web/src/components/data-primitives.tsx`, migrate existing cockpit call sites, and register `cez/use-data-primitives` in `packages/cezar/src/lint/`.
3. **Shared task model & `<TaskTable />`:** Add `packages/web/src/lib/task-model.ts`, `packages/web/src/components/task-telemetry-popover.tsx`, and `packages/web/src/components/task-table.tsx` (`table`, `compact`, `card` densities) with `runner` and `usage` columns in `packages/web/src/lib/task-columns.ts`.
4. **Two-tier chrome & route unification:** Unify `packages/web/src/routes/task-list-parts.tsx`, `tasks-overview.tsx`, `global-tasks.tsx`, and `task-lists.css` inside `<TablePage headerSpacing="compact">` with shared `TaskViewTabs`, `TaskBulkActions`, `TaskColumnsPopover`, and `TaskControlStrip`.
5. **Tests & verification:** Update affected unit and browser E2E specs, verify typecheck, lint, `prepr`, and visual craft across desktop and mobile light/dark themes.

## Case tables

### State restore cases (workspace column visibility)

| Path or trigger | Restored value | Displayed value |
| --- | --- | --- |
| Reopen without saved `taskTable.expandedColumns` | `{}` | Unified defaults: `Task`, `Workflow`, `Changes`, `Reference` (when present), `Usage`, `Started` expanded; `Runner`, `Branch` collapsed |
| Switch between Project Tasks and Global Tasks | Shared `workspaceQueryKeys.uiState` `expandedColumns` | Identical visible unified columns on both routes |
| Saved state contains malformed or unknown column keys | `normalizeExpandedColumns` keeps valid foldable booleans only | Defaults apply for malformed keys; unknown keys survive writes untouched |
| Capability hides tokens/cost (`CEZ_HIDE_COST` / `CEZ_HIDE_TOKENS`) | Saved `expandedColumns` unchanged | `Usage` popover and summary omit hidden metric; detailed resource table omits hidden metric columns |
