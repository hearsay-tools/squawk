import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import { collectedOnly, partitionParity, type CellBody, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { AUTONOMOUS_CRITERIA, exemptionFor, type ParityExemption } from './harness-parity-core.testkit.ts';
import { PARITY_ROSTER, runsOn } from './parity-classes.testkit.ts';
import { isRegisteredRunner } from './runner-registry.ts';

// The workflow-autonomous cells and their partition, apart from the engine the cell bodies
// drive, so the registration guard collects the same names without loading it.
const PARTS: Readonly<Record<string, readonly string[]>> = {
  budget: [
    'fixture A5 fresh',
    'fixture A5 continuation',
    'fixture A11 fresh',
    'fixture A12 continuation',
  ],
  engine: [
    'fixture A1 fresh',
    'fixture A2 continuation',
    'fixture A3 fresh',
    'fixture A4 continuation',
    'fixture A6 fresh',
    'fixture A6 continuation',
    'fixture A7 fresh',
    'fixture A8 fresh',
    'fixture A10 fresh',
    'fixture A16',
  ],
  'idle-close-fresh': BUILT_IN_RUNNER_IDS.map(runner => `${runner} A13`),
  'idle-close-continuation': BUILT_IN_RUNNER_IDS.map(runner => `${runner} A14`),
  'ack-bound': BUILT_IN_RUNNER_IDS.map(runner => `${runner} A15`),
  'native-questions': [
    'claude A9',
    'codex A9 fresh',
    'omp A9',
    'opencode A9 fresh',
    'pi A9',
    'antigravity A9 fresh',
  ],
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

type AutonomousIt = ReturnType<typeof partitionParity>['it'];

function registerAutonomousRow(it: AutonomousIt, cells: WorkflowAutonomousCells, backend: string, row: AutonomousRow): void {
  const exemption = exemptionFor(row.id, backend);
  if (row.id === 'A13' || row.id === 'A14') {
    // Claude's stdin write is its acknowledgement.
    const options = { refuses: !exemption, heldAck: backend !== 'claude' };
    it(`${backend} ${row.id} ${exemption ? `exemption — ${exemption.reason}` : row.name}`,
      cells.idleClose(backend, row, options), 60_000);
    return;
  }
  if (row.id === 'A16') {
    it(`${backend} ${row.id} ${row.name}`, cells.answerBound(backend), 60_000);
    return;
  }
  if (row.id === 'A15') {
    it(`${backend} ${row.id} ${exemption ? `exemption — ${exemption.reason}` : row.name}`,
      cells.ackBound(backend, exemption), 60_000);
    return;
  }
  if (exemption) {
    it(`${backend} ${row.id} exemption — ${exemption.reason}`, cells.exemption(backend));
    return;
  }
  // Cap and non-autonomous controls exercise both constructors as well.
  const modes = row.id === 'A2' || row.id === 'A4' || row.id === 'A12' ? ['continuation'] : row.id === 'A5' || row.id === 'A6' ? ['fresh', 'continuation'] : ['fresh'];
  for (const mode of modes) it(`${backend} ${row.id} ${row.name} (${mode})`, cells.row(backend, row, mode),
    row.id === 'A5' || row.id === 'A11' || row.id === 'A12' ? cells.capRowTimeoutMs : 30_000);
}

/** The registrar over each kind of cell body per runner and criterion. */
export function workflowAutonomousParity(cells: WorkflowAutonomousCells) {
  return function describeWorkflowAutonomousParity(part: ParityPart, collect?: ParityCollector): void {
    const { describe, it } = partitionParity(part, PARTS, collect, 'workflow-autonomous');
    describe('autonomous turn-end parity — #426', () => {
      for (const backend of PARITY_ROSTER) {
        if (part !== 'all' && !isRegisteredRunner(backend)) continue;
        for (const row of AUTONOMOUS_CRITERIA) {
          if (!runsOn('workflow-autonomous', row.id, backend)) continue;
          registerAutonomousRow(it, cells, backend, row);
        }
      }
    });
  };
}

/** The same cells by name only, for the registration guard. */
export const workflowAutonomousCellNames = workflowAutonomousParity({
  idleClose: collectedOnly, answerBound: collectedOnly, ackBound: collectedOnly, exemption: collectedOnly, row: collectedOnly, capRowTimeoutMs: 0,
});
