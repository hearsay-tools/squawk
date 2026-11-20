import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';
import { collectedOnly, partitionParity, type CellBody, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { NO_PROGRESS_CRITERIA, exemptionFor } from './harness-parity-core.testkit.ts';

// The workflow-no-progress cells and their partition, apart from the engine the cell bodies
// drive, so the registration guard collects the same names without loading it.
const PARTS: Readonly<Record<string, readonly string[]>> = {
  "progress": [
    "claude N1",
    "claude N2",
    "codex N1",
    "codex N2",
    "cursor N1",
    "cursor N2",
    "omp N1",
    "omp N2",
    "opencode N1",
    "opencode N2",
    "pi N1",
    "pi N2"
  ],
  "parked-input": [
    "claude N3",
    "claude N6",
    "codex N3",
    "codex N6",
    "cursor N3",
    "cursor N6",
    "omp N3",
    "omp N6",
    "opencode N3",
    "opencode N6",
    "pi N3",
    "pi N6"
  ],
  "continue-steer": [
    "claude N4",
    "claude N8",
    "codex N4",
    "codex N8",
    "cursor N4",
    "cursor N8",
    "omp N4",
    "omp N8",
    "opencode N4",
    "opencode N8",
    "pi N4",
    "pi N8"
  ],
  "process-exit": [
    "claude N5",
    "claude N7",
    "codex N5",
    "codex N7",
    "cursor N5",
    "cursor N7",
    "omp N5",
    "omp N7",
    "opencode N5",
    "opencode N7",
    "pi N5",
    "pi N7"
  ]
};

export type WorkflowNoProgressCells = {
  exemption: (backend: string) => CellBody;
  row: (backend: string, row: (typeof NO_PROGRESS_CRITERIA)[number]) => CellBody;
};

/** The registrar over the exemption and row cell bodies per runner and criterion. */
export function workflowNoProgressParity(cells: WorkflowNoProgressCells) {
  return function describeWorkflowNoProgressParity(part: ParityPart, collect?: ParityCollector): void {
    const { describe, it } = partitionParity(part, PARTS, collect);
    describe('managed open-turn inactivity — #470', () => {
      for (const backend of BUILT_IN_RUNNER_IDS) {
        for (const row of NO_PROGRESS_CRITERIA) {
          const exemption = exemptionFor(row.id, backend);
          if (exemption) {
            it(`${backend} ${row.id} exemption — ${exemption.reason}`, cells.exemption(backend));
            continue;
          }
          it(`${backend} ${row.id} ${row.name}`, cells.row(backend, row), 30_000);
        }
      }
    });
  };
}

/** The same cells by name only, for the registration guard. */
export const workflowNoProgressCellNames = workflowNoProgressParity({ exemption: collectedOnly, row: collectedOnly });
