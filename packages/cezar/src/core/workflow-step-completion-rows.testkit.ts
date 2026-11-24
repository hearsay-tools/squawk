import { collectedOnly, partitionParity, type CellBody, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { STEP_COMPLETION_CRITERIA } from './harness-parity-core.testkit.ts';
import { PARITY_ROSTER } from './parity-classes.testkit.ts';

// The workflow-step-completion cells and their partition, apart from the engine the cell bodies
// drive, so the registration guard collects the same names without loading it.
// hearsay-tools/cezarion#1620: an earlier workflow step completes only on an accepted completion
// signal, on every runner's native wire. Its last agent step signals done; a check step ends the chain.
// hearsay-tools/squawk#1621 (C7): the workflow position survives a worktree setup that fails before
// the tail starts.
const PARTS: Readonly<Record<string, readonly string[]>> = {
  engine: ['fixture C1', 'fixture C3', 'fixture C4', 'fixture C5', 'fixture C6', 'fixture C7'],
};

export type WorkflowStepCompletionCell = (backend: string, row: (typeof STEP_COMPLETION_CRITERIA)[number]) => CellBody;

/** The registrar over one cell body per runner and criterion. */
export function workflowStepCompletionParity(cell: WorkflowStepCompletionCell) {
  return function describeWorkflowStepCompletionParity(part: ParityPart, collect?: ParityCollector): void {
    const { describe, it } = partitionParity(part, PARTS, collect, 'workflow-step-completion');
    describe('explicit step completion parity — hearsay-tools/cezarion#1620', () => {
      for (const backend of PARITY_ROSTER) for (const row of STEP_COMPLETION_CRITERIA) it(`${backend} ${row.id} ${row.name}`, cell(backend, row), 60_000);
    });
  };
}

/** The same cells by name only, for the registration guard. */
export const workflowStepCompletionCellNames = workflowStepCompletionParity(collectedOnly);
