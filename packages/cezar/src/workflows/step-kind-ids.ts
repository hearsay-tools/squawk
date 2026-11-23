/**
 * Plain-data workflow step-kind tables for lint rules and tests (spec
 * 2026-11-23-open-registries-and-tables, ADR 0069). Zero runtime imports keep
 * engine, runner, and feature modules out of the lint plugin's closure.
 * Aligned with `workflows/step-kind-registry.ts` and
 * `@open-mercato/cezar-contract/run-status` by `workflows/extension-ids.test.ts`.
 */
export const BUILT_IN_STEP_KINDS = ['agent', 'check'] as const;

export const CONTRACT_STEP_KINDS = [...BUILT_IN_STEP_KINDS, 'plugin'] as const;
