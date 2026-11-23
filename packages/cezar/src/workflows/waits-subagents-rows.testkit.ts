
import type { RunnerFacts } from '../core/runner-facts.ts';

/**
 * The rows and exemption rules of `waits-subagents-parity-cells.testkit.ts`, as plain data: that kit
 * imports the workflow engine, so nothing outside Vitest can load it. `scripts/parity-rows.ts`
 * prints these rows alongside `waits-subagents-exemptions.testkit.ts`.
 */
export const SUBAGENT_CRITERIA = [
  { id: 'U30', name: 'a turn that ends with a background subagent running parks waiting for 1 subagent, with no timer and no wake spent' },
  { id: 'U31', name: 'the runner resuming the parent itself closes the subagent wait and every timer, and Squawk sends no wake' },
  { id: 'U32', name: 'the child ending with no parent turn wakes the parent once after the grace, for free' },
  { id: 'U33', name: 'a failed child wakes the parent once, for free' },
  { id: 'U34', name: 'a stopped child wakes the parent once, for free' },
  { id: 'U35', name: 'a duplicate child notification wakes nothing more' },
  { id: 'U36', name: 'the deadline wakes the parent and spends one wake' },
  { id: 'U37', name: 'a restart with no session continues the parent once, for free, saying its subagents stopped' },
] as const;
export type SubagentCriterion = (typeof SUBAGENT_CRITERIA)[number]['id'];

export interface SubagentExemption {
  readonly criterion: SubagentCriterion;
  readonly runner: string;
  readonly reason: string;
}

const NO_SIGNAL = (runner: string) => `${runner}'s native wire reports no start or end of a background child to Squawk, so its sessions keep the monitoring timer (owner decision 3 of hearsay-tools/cezarion#2431).`;
const TURNED_OFF = (runner: string) => `Squawk turns ${runner}'s native subagent tools off (a hook denies each call), so no child runs and no row applies.`;
const NEVER_SETTLES = (runner: string) => `${runner}'s parent turn never ends while its subagents run: the wire holds the turn open until every child returns, so no turn end parks on running children.`;

const CODEX_EXEMPTIONS: readonly SubagentExemption[] = [
  { criterion: 'U31', runner: 'codex', reason: 'Codex app-server never starts a parent turn by itself when a spawned child ends (live codex-cli 0.164.0 wire, watched for 2.5 minutes): the child\'s end reaches the parent only as a subAgentActivity item on the already-completed turn, so Squawk\'s grace wake is the only resume.' },
  ...(['U33', 'U34'] as const).map(criterion => ({ criterion, runner: 'codex' as const,
    reason: 'Codex app-server reports a child\'s end as subAgentActivity kind completed only; no failed, interrupted or cancelled child frame was observed on the live wire, so a child that fails is seen at the 30-minute deadline (U36).' })),
];

/** Every subagent exemption for one runner, evaluated from its own declared `nativeSubagents`. */
export function subagentExemptionsFor(runner: string, facts: RunnerFacts): SubagentExemption[] {
  if (facts.nativeSubagents === 'unreported') return SUBAGENT_CRITERIA.map(({ id }) => ({ criterion: id, runner, reason: NO_SIGNAL(runner) }));
  if (facts.nativeSubagents === 'none') return SUBAGENT_CRITERIA.map(({ id }) => ({ criterion: id, runner, reason: TURNED_OFF(runner) }));
  if (facts.nativeSubagents === 'turn-held') return SUBAGENT_CRITERIA.map(({ id }) => ({ criterion: id, runner, reason: NEVER_SETTLES(runner) }));
  return CODEX_EXEMPTIONS.filter(entry => entry.runner === runner);
}

/** Whether `runner` is exempt from `criterion`, evaluated from its own declared facts. */
export function subagentExemptionFor(criterion: SubagentCriterion, runner: string, facts: RunnerFacts): SubagentExemption | undefined {
  return subagentExemptionsFor(runner, facts).find(entry => entry.criterion === criterion);
}
