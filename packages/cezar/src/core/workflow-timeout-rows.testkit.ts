import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { collectedOnly, partitionParity, type CellBody, type ParityPart, type ParityCollector } from './parity-partition.testkit.ts';
import { WORKFLOW_TIMEOUT_CRITERIA } from './harness-parity-core.testkit.ts';

// The workflow-timeout cells and their partition, apart from the engine the cell bodies drive,
// so the registration guard collects the same names without loading it.
// T1, T2, T3, T5 and T6 test which deadline Squawk passes (`step.timeoutMs ?? 0`,
// workflows/run/step-session.ts) and what a timed-out step does, and run on the scenario runner.
// T7 is their seam row: each runner applies a set `spec.timeoutMs` in place of its own default.
// T4 and T7 run on every runner (core/parity-classes.testkit.ts).
// The family's class drops the cells a runner does not run before a part is chosen.
const cells = (...rows: string[]) => BUILT_IN_RUNNER_IDS.flatMap(runner => rows.map(row => `${runner} ${row}`));
const PARTS: Readonly<Record<string, readonly string[]>> = {
  defaults: cells('T1', 'T6'),
  'explicit-zero': cells('T2', 'T7'),
  'authored-and-standalone': cells('T3', 'T4', 'T5'),
};

export type WorkflowTimeoutCell = (backend: string, criterion: (typeof WORKFLOW_TIMEOUT_CRITERIA)[number]) => CellBody;

/** The registrar over one cell body per runner and criterion. */
export function workflowTimeoutParity(cell: WorkflowTimeoutCell) {
  return function describeWorkflowTimeoutParity(part: ParityPart, collect?: ParityCollector): void {
    const { describe, it } = partitionParity(part, PARTS, collect, 'workflow-timeout');
    describe('workflow wall-clock policy — #470', () => {
      for (const backend of BUILT_IN_RUNNER_IDS) {
        for (const criterion of WORKFLOW_TIMEOUT_CRITERIA) it(`${backend} ${criterion.id} ${criterion.name}`, cell(backend, criterion), 30_000);
      }
    });
  };
}

/** The same cells by name only, for the registration guard. */
export const workflowTimeoutCellNames = workflowTimeoutParity(collectedOnly);
