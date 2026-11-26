import type { afterAll, beforeAll, describe, it } from 'vitest';
import { MONITORING_TURN_CRITERIA, MONITORING_ACK_CRITERIA, MONITORING_ORDER_CRITERIA } from '../workflows/monitoring-turn.testkit.ts';
import { WAIT_CRITERIA } from '../workflows/waits-parity.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import {
  ANSWER_DELIVERY_CRITERIA, AUTONOMOUS_CRITERIA, FINAL_MESSAGE_CRITERIA, FOLLOWUP_CRITERIA, MODEL_REFUSAL_CRITERIA, NO_PROGRESS_CRITERIA,
  PERMISSION_CRITERIA, SHUTDOWN_CRITERIA, SKILL_PROVISION_CRITERIA, SKILL_RESUME_CRITERIA, STEP_COMPLETION_CRITERIA, WORKER_PROGRESS_WAIT_CRITERIA,
  WORKFLOW_ASK_CRITERIA, WORKFLOW_TIMEOUT_CRITERIA, WORKTREE_SETUP_CRITERIA, type ScenarioName,
} from './harness-parity-core.testkit.ts';
import { CONTRACT_GROUPS } from './harness-parity-contract.cells.testkit.ts';
import { ownedInputGroups } from './harness-parity-owned-input.rows.testkit.ts';
import { ownedWorkflowsGroups } from './harness-parity-owned-workflows.rows.testkit.ts';
import { ownershipGroups } from './harness-parity-ownership.rows.testkit.ts';
import { pendingRequestGroups } from './harness-parity-pending-request.rows.testkit.ts';
import { providerGroups } from './harness-parity-provider.rows.testkit.ts';
import { describeHarnessGroups, type CellBody, type HarnessGroup, type ObservedCell } from './harness-parity-registrar.testkit.ts';
import { CONTROL_CRITERIA, FOLLOW_ON_ROWS, INPUT_ROWS, RUN_ROWS } from './harness-parity-rows.testkit.ts';
import { runGroups } from './harness-parity-run.rows.testkit.ts';
import { SEAM_CRITERIA } from './harness-parity-seam-tier.testkit.ts';
import { SESSION_GROUPS } from './harness-parity-session.cells.testkit.ts';
import { settlementGroups } from './harness-parity-settlement.rows.testkit.ts';
import { STARTUP_GROUPS } from './harness-parity-startup.cells.testkit.ts';
import { parityRowId, PARITY_ROSTER } from './parity-classes.testkit.ts';
import { runnerDefinition } from './runner-registry.ts';
import { SEAM_CONTRACT_ROWS } from './seam-contract.testkit.ts';

export { HARNESS_PARITY_GROUPS } from './harness-parity-parts.testkit.ts';

/**
 * Which rows the harness parity groups register, read without the workflow engine
 * (hearsay-tools/squawk#3962). The engine-bound parts register through their name-only
 * `harness-parity-<part>.rows.testkit.ts` modules, here with collector cells; the other parts'
 * cells modules load no engine. `harness-parity.test.ts` holds this collection equal to the
 * real one over every group, so `parity-classes.test.ts` reads it and reruns on no engine edit.
 */

/** Every matrix row with the scenario it drives, as the matrix guard reads them. */
export function parityRowScenarios(): ReadonlyArray<{ readonly id: string; readonly scenario: ScenarioName }> {
  return [
    ...PERMISSION_CRITERIA, ...MODEL_REFUSAL_CRITERIA, ...SHUTDOWN_CRITERIA,
    ...MONITORING_TURN_CRITERIA, ...MONITORING_ACK_CRITERIA, ...MONITORING_ORDER_CRITERIA,
    ...WAIT_CRITERIA, ...WORKFLOW_ASK_CRITERIA, ...STEP_COMPLETION_CRITERIA, ...FOLLOWUP_CRITERIA,
    ...ANSWER_DELIVERY_CRITERIA, ...SKILL_RESUME_CRITERIA, ...SKILL_PROVISION_CRITERIA,
    ...WORKTREE_SETUP_CRITERIA, ...AUTONOMOUS_CRITERIA, ...WORKER_PROGRESS_WAIT_CRITERIA,
    ...FINAL_MESSAGE_CRITERIA, ...NO_PROGRESS_CRITERIA, ...WORKFLOW_TIMEOUT_CRITERIA,
    ...SEAM_CRITERIA, ...SEAM_CONTRACT_ROWS, ...INPUT_ROWS, ...FOLLOW_ON_ROWS, ...CONTROL_CRITERIA, ...RUN_ROWS,
  ];
}

/** A cell the collection registers and never runs: a body, and a `parityRow` observation. */
const COLLECTED: CellBody & ObservedCell<never> = Object.assign(
  async () => { throw new Error('a collected harness parity cell never runs'); },
  {
    assert: () => { throw new Error('a collected harness parity cell never runs'); },
    observe: async () => { throw new Error('a collected harness parity cell never runs'); },
  },
);

/** Every cell of a part's typed record, as the collected cell. */
const collectedCells = <Cells extends object>(): Cells => new Proxy({}, { get: () => () => COLLECTED }) as Cells;

/** Every group that registers row cells on a runner, with its bodies left out where they load the engine. */
const NAME_ONLY_GROUPS: readonly HarnessGroup[] = [
  ...Object.values(CONTRACT_GROUPS), ...Object.values(STARTUP_GROUPS), ...Object.values(SESSION_GROUPS),
  ...Object.values(runGroups(collectedCells())), ...Object.values(providerGroups(collectedCells())),
  ...Object.values(ownershipGroups(collectedCells())), ...Object.values(ownedInputGroups(collectedCells())),
  ...Object.values(ownedWorkflowsGroups(collectedCells())), ...Object.values(settlementGroups(collectedCells())),
  ...Object.values(pendingRequestGroups(collectedCells())),
];

/** The row ids each of `groups` registers on any runner, from its cell titles (hearsay-tools/cezarion#2991). */
export function collectGroupRows(groups: readonly HarnessGroup[]): Map<string, Set<string>> {
  const rows = new Map<string, Set<string>>();
  for (const runner of PARITY_ROSTER) {
    const definition = runner === fixtureRunner.id ? fixtureRunner : runnerDefinition(runner);
    describeHarnessGroups({ runner: definition, part: 'session' }, {
      describe: ((_name: string, ...args: unknown[]) => { (args.at(-1) as () => void)(); }) as typeof describe,
      it: (() => undefined) as unknown as typeof it,
      beforeAll: (() => undefined) as typeof beforeAll,
      afterAll: (() => undefined) as typeof afterAll,
      toolGrants: () => undefined,
      allGroups: true,
      probe: (group, title) => {
        const row = parityRowId(title);
        if (row) rows.set(group, (rows.get(group) ?? new Set()).add(row));
      },
    }, groups);
  }
  return rows;
}

/** The row ids each harness group registers on any runner, collected without the workflow engine. */
export function harnessGroupRows(): Map<string, Set<string>> {
  return collectGroupRows(NAME_ONLY_GROUPS);
}
