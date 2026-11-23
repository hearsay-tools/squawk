import { factRows } from '../core/runner-fact-rows.testkit.ts';
import { subagentExemptionsFor, type SubagentExemption } from './waits-subagents-rows.testkit.ts';

/**
 * Every built-in runner's native-subagent parity exemptions, for `scripts/parity-rows.ts` and
 * cross-runner guards. Single-runner subagent parity tests call `subagentExemptionFor` from
 * `waits-subagents-rows.testkit.ts` instead (hearsay-tools/squawk#4175).
 */
export const SUBAGENT_EXEMPTIONS: readonly SubagentExemption[] = Object.entries(factRows()).flatMap(
  ([runner, facts]) => subagentExemptionsFor(runner, facts),
);
