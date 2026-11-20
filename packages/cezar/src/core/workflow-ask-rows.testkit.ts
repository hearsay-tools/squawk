import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { afterEach, describe, it, vi } from 'vitest';
import { runsOn } from './parity-classes.testkit.ts';
import { WORKFLOW_ASK_CRITERIA } from './harness-parity-core.testkit.ts';
import { collectedOnly, type CellBody } from './parity-partition.testkit.ts';

// The workflow ask cells and their groups, apart from the engine the cell bodies drive,
// so the registration guard collects the same names without loading it.
export const WORKFLOW_ASK_GROUPS = {'continue': ['Q4'], 'restart': ['Q5'], 'cancel': ['Q6'], 'timeout': ['Q8']} as const;

export type WorkflowAskCell = (backend: string, row: (typeof WORKFLOW_ASK_CRITERIA)[number]) => CellBody;

/** The registrar over one cell body per runner and row. */
export function workflowAsk(cell: WorkflowAskCell) {
  return function describeWorkflowAsk(group: keyof typeof WORKFLOW_ASK_GROUPS, registration = { describe, it, afterEach }) {
    const { describe, it, afterEach } = registration;
    describe('intermediate workflow ASK parity — #427', () => {
      afterEach(() => vi.restoreAllMocks());
      for (const backend of BUILT_IN_RUNNER_IDS) for (const row of WORKFLOW_ASK_CRITERIA.filter(row => { return (WORKFLOW_ASK_GROUPS[group] as readonly string[]).includes(row.id) && runsOn('workflow-ask', row.id, backend); })) {
        it(`${backend} ${row.id} ${row.name} (fresh)`, cell(backend, row), 30_000);
      }
    });
  };
}

/** The same cells by name only, for the registration guard. */
export const workflowAskCellNames = workflowAsk(collectedOnly);
