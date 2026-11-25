import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import { describe, it } from 'vitest';
import { runsOn } from './parity-classes.testkit.ts';
import { FINAL_MESSAGE_CRITERIA, exemptionFor } from './harness-parity-core.testkit.ts';
import { collectedOnly, type CellBody } from './parity-partition.testkit.ts';

// The no-wait nudge cells and their groups, apart from the engine the cell bodies drive,
// so the registration guard collects the same names without loading it.
export const WORKFLOW_FINAL_MESSAGE_GROUPS = {'ack-delay': ['F7'], 'reply-bound': ['F8'], 'late-reply': ['F9', 'F11'], 'content-budget': ['F10']} as const;

type FinalMessageRow = (typeof FINAL_MESSAGE_CRITERIA)[number];
export type WorkflowFinalMessageCells = {
  exemption: (backend: string, row: FinalMessageRow) => CellBody;
  row: (backend: string, row: FinalMessageRow) => CellBody;
};

// The rows a runner may exempt, with the exemption cell's timeout: F8's exemption still drives a run.
const EXEMPTION_TIMEOUT_MS = new Map<string, number | undefined>([['F7', undefined], ['F8', 30_000], ['F9', undefined], ['F11', undefined]]);

/** The registrar over an exemption cell or a run cell per runner and row. */
export function workflowFinalMessage(cells: WorkflowFinalMessageCells) {
  return function describeWorkflowFinalMessage(group: keyof typeof WORKFLOW_FINAL_MESSAGE_GROUPS, registration = { describe, it }) {
    const { describe, it } = registration;
    describe('no-wait nudge parity — #544, hearsay-tools/cezarion#1234', () => {
      for (const backend of BUILT_IN_RUNNER_IDS) {
        for (const row of FINAL_MESSAGE_CRITERIA.filter(row => { return (WORKFLOW_FINAL_MESSAGE_GROUPS[group] as readonly string[]).includes(row.id) && runsOn('workflow-final-message', row.id, backend); })) {
          const exemption = EXEMPTION_TIMEOUT_MS.has(row.id) ? exemptionFor(row.id, backend) : undefined;
          if (exemption) it(`${backend} ${row.id} exemption — ${exemption.reason}`, cells.exemption(backend, row), EXEMPTION_TIMEOUT_MS.get(row.id));
          else it(`${backend} ${row.id} ${row.name}`, cells.row(backend, row), 30_000);
        }
      }
    });
  };
}

/** The same cells by name only, for the registration guard. */
export const workflowFinalMessageCellNames = workflowFinalMessage({ exemption: collectedOnly, row: collectedOnly });
