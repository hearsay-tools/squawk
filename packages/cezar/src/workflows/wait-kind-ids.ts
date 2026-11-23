/**
 * Plain-data wait-kind and wait-via tables for lint rules and tests (spec
 * 2026-11-23-open-registries-and-tables, ADR 0069). Zero runtime imports keep
 * engine, runner, and feature modules out of the lint plugin's closure.
 * Aligned with `built-in-wait-kinds.ts` and `@open-mercato/cezar-contract/waits`
 * by `workflows/extension-ids.test.ts`.
 */
export const BUILT_IN_WAIT_KINDS = [
  'pr',
  'timer',
  'human',
  'worker',
  'process',
  'peer',
  'subagent',
] as const;

export const LEGACY_WAIT_KINDS = ['ci'] as const;

export const CONTRACT_WAIT_KINDS = [...BUILT_IN_WAIT_KINDS, 'plugin'] as const;

export const BUILT_IN_WAIT_VIAS = [
  'cezar_wait',
  'cezar_wait_for_ci',
  'cezar_ask',
  'monitoring-line',
  'schedule-wakeup',
  'ask-line',
  'native-ask',
  'no-wait',
  'budget',
  'cez-worker-wait',
  'completion',
  'cez-message-wait',
  'native-subagents',
] as const;
