# Harness parity: name-only groups apart from the engine-bound cells
Status: active

Issue: hearsay-tools/squawk#3962 (parent hearsay-tools/squawk#3956)

## Why

`core/parity-classes.test.ts` reads which rows each harness group registers through
`harnessGroupRows()` in `core/harness-parity-cells.testkit.ts`. That function runs every group's
real registrar dry, and seven part modules bind the run engine at module scope. So the guard
reruns on every edit to `workflows/run.ts`. Squeal follows `import()` too, so a lazy import does
not help.

The repository already has the pattern that fixes this. `core/harness-parity-rows.testkit.ts`
holds rows as plain data, and the cells attach their assertions by id.
`workflows/session-context-rows.testkit.ts` and `workflows/resume-diagnostics-rows.testkit.ts`
hold a typed registrar apart from the cell bodies. A static group-to-rows table was rejected: it
would be a second inventory of the same rows, checked only at test time.

## Shape

For each engine-bound part `<part>`, an engine-free module
`core/harness-parity-<part>.rows.testkit.ts` exports:

- `<Part>Cells`: a type with one key per cell site. The key is the row id, or a short name where
  the title has none. Each value takes the loop values (backend, variant, ask case) and returns
  the body, or `{ assert, observe }` for a `parityRow` cell.
- `<part>Groups(cells: <Part>Cells)`: the part's `HarnessGroup` record. It holds every
  `describeRunners`, `describe`, `it`, loop and branch that decides which cells exist, with
  their titles and timeouts. A body that is already engine-free and only pins an exemption
  (`exemptionFor`, `HARNESS_ADAPTERS`) stays here whole.

The existing `core/harness-parity-<part>.cells.testkit.ts` keeps the bodies, moved verbatim into
a typed `<Part>Cells` record, and exports `<PART>_GROUPS = <part>Groups(CELLS)`. Its
`describeHarnessParity` and every runner entry file stay as they are. A missing or misnamed body
fails `tsc`.

The run tier splits the same way. `core/harness-parity-run-tier.rows.testkit.ts` holds the
`runRows` registration loop over the plain `RUN_ROWS` data. `core/harness-parity-run-tier.testkit.ts`
keeps the `RUN_CELLS` assertions and the drives, and exports `runRowCell`.

No assertion changes. Only titles and registration move.

## Slices

One PR each. Each keeps `main` green.

1. Run tier, `run`, `provider`.
2. `settlement`.
3. `pending-request`.
4. `ownership`.
5. `owned-input` and `owned-workflows`.
6. Close the issue. Add `core/harness-parity-inventory.testkit.ts` (engine-free) with
   `parityRowScenarios()` and `harnessGroupRows()`, which runs every part's name-only groups dry
   with collector cells. `core/parity-classes.test.ts` changes its import only. A guard in
   `core/harness-parity.test.ts` asserts that the name-only collection equals the real dry
   collection over `HARNESS_PARITY_ORDER`. The PR states the drop with
   `node scripts/import-reach.mjs packages/cezar/src/workflows/run.ts` and
   `.ai/specs/assets/2026-11-19-run-manager-testkit-classification/measure.mjs`.

Each of slices 1–5 also:

- adds its new modules to `HARNESS_PARITY_KITS` in `core/harness-parity-cells.testkit.ts`;
- adds them to the engine-free list in `core/harness-parity-closure.test.ts`;
- keeps the structure comments in `core/harness-parity-cells.testkit.ts` true.

## Verification

- Squeal verdicts on the part's runner entry files (`runners/*/harness-*-<part>-parity.test.ts`),
  `core/harness-parity.test.ts`, `core/parity-classes.test.ts` and
  `core/harness-parity-closure.test.ts`.
- `core/harness-parity.test.ts` "registers every criterion and runner exactly once across its
  part files" compares full titles per runner, so it proves a slice registers the same cells.
- `npm run typecheck`, `npm run lint`, `npm run prepr`.
