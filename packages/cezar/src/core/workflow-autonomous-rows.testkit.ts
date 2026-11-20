import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { collectedOnly, partitionParity, type CellBody, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { AUTONOMOUS_CRITERIA, exemptionFor, type ParityExemption } from './harness-parity-core.testkit.ts';

// The workflow-autonomous cells and their partition, apart from the engine the cell bodies
// drive, so the registration guard collects the same names without loading it.
const PARTS: Readonly<Record<string, readonly string[]>> = {
  "budget-fresh": [
    "claude A5 fresh"
  ],
  "budget-continuation": [
    "claude A5 continuation"
  ],
  "late-readiness-fresh": [
    "claude A11 fresh"
  ],
  "late-readiness-continuation": [
    "claude A12 continuation"
  ],
  "nudges": [
    "claude A1 fresh",
    "claude A2 continuation"
  ],
  "ask-refusal": [
    "claude A3 fresh",
    "claude A4 continuation"
  ],
  "unanswered-question": [
    "claude A10 fresh"
  ],
  "non-autonomous": [
    "claude A6 continuation",
    "claude A6 fresh"
  ],
  "tool-parking": [
    "claude A7 fresh",
    "claude A8 fresh"
  ],
  "idle-close-fresh": [
    "claude A13",
    "codex A13",
    "cursor A13",
    "omp A13",
    "opencode A13",
    "pi A13"
  ],
  "idle-close-continuation": [
    "claude A14",
    "codex A14",
    "cursor A14",
    "omp A14",
    "opencode A14",
    "pi A14"
  ],
  "ack-bound": [
    "claude A15",
    "codex A15",
    "cursor A15",
    "omp A15",
    "opencode A15",
    "pi A15"
  ],
  "answer-bound": [
    "claude A16"
  ],
  "native-questions": [
    "claude A9",
    "codex A9 fresh",
    "cursor A9",
    "omp A9",
    "opencode A9 fresh",
    "pi A9"
  ]
};

type AutonomousRow = (typeof AUTONOMOUS_CRITERIA)[number];
export type WorkflowAutonomousCells = {
  idleClose: (backend: string, row: AutonomousRow, options: { refuses: boolean; heldAck: boolean }) => CellBody;
  answerBound: (backend: string) => CellBody;
  ackBound: (backend: string, exemption: ParityExemption | undefined) => CellBody;
  exemption: (backend: string) => CellBody;
  row: (backend: string, row: AutonomousRow, mode: string) => CellBody;
  /** The cell timeout of the cap rows (A5, A11, A12). */
  capRowTimeoutMs: number;
};

/** The registrar over each kind of cell body per runner and criterion. */
export function workflowAutonomousParity(cells: WorkflowAutonomousCells) {
  return function describeWorkflowAutonomousParity(part: ParityPart, collect?: ParityCollector): void {
    const { describe, it } = partitionParity(part, PARTS, collect, 'workflow-autonomous');
    describe('autonomous turn-end parity — #426', () => {
      for (const backend of BUILT_IN_RUNNER_IDS) {
        for (const row of AUTONOMOUS_CRITERIA) {
          const exemption = exemptionFor(row.id, backend);
          if (row.id === 'A13' || row.id === 'A14') {
            // Claude's stdin write is its acknowledgement.
            const options = { refuses: !exemption, heldAck: backend !== 'claude' };
            it(`${backend} ${row.id} ${exemption ? `exemption — ${exemption.reason}` : row.name}`,
              cells.idleClose(backend, row, options), 60_000);
            continue;
          }
          if (row.id === 'A16') {
            it(`${backend} ${row.id} ${row.name}`, cells.answerBound(backend), 60_000);
            continue;
          }
          if (row.id === 'A15') {
            it(`${backend} ${row.id} ${exemption ? `exemption — ${exemption.reason}` : row.name}`,
              cells.ackBound(backend, exemption), 60_000);
            continue;
          }
          if (exemption) {
            it(`${backend} ${row.id} exemption — ${exemption.reason}`, cells.exemption(backend));
            continue;
          }
          // Cap and non-autonomous controls exercise both constructors as well.
          const modes = row.id === 'A2' || row.id === 'A4' || row.id === 'A12' ? ['continuation'] : row.id === 'A5' || row.id === 'A6' ? ['fresh', 'continuation'] : ['fresh'];
          for (const mode of modes) it(`${backend} ${row.id} ${row.name} (${mode})`, cells.row(backend, row, mode),
            row.id === 'A5' || row.id === 'A11' || row.id === 'A12' ? cells.capRowTimeoutMs : 30_000);
        }
      }
    });
  };
}

/** The same cells by name only, for the registration guard. */
export const workflowAutonomousCellNames = workflowAutonomousParity({
  idleClose: collectedOnly, answerBound: collectedOnly, ackBound: collectedOnly, exemption: collectedOnly, row: collectedOnly, capRowTimeoutMs: 0,
});
