import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { describe, it } from 'vitest';
import { exemptionFor, FOLLOWUP_CRITERIA } from './harness-parity-core.testkit.ts';
import { collectedOnly, type CellBody } from './parity-partition.testkit.ts';

// The mid-turn follow-up cells and their groups, apart from the engine the cell bodies drive,
// so the registration guard collects the same names without loading it.
export const WORKFLOW_FOLLOWUP_GROUPS = {
  'turn-end': { rows: ['H1', 'H2'], modes: ['fresh'] },
  'hold': { rows: ['H3'], modes: ['fresh', 'continuation'] },
  'late-start-fresh': { rows: ['H4'], modes: ['fresh'] },
  'late-start-continuation': { rows: ['H4'], modes: ['continuation'] },
  'late-ack-fresh': { rows: ['H5'], modes: ['fresh'] },
  'late-ack-continuation': { rows: ['H5'], modes: ['continuation'] },
} as const;

type FollowupRow = (typeof FOLLOWUP_CRITERIA)[number];
export type WorkflowFollowupCells = {
  exemption: (backend: string, row: FollowupRow) => CellBody;
  row: (backend: string, row: FollowupRow, mode: 'fresh' | 'continuation', lateStart: boolean) => CellBody;
};

/** The registrar over an exemption cell or one run cell per mode, per runner and row. */
export function workflowFollowup(cells: WorkflowFollowupCells) {
  return function describeWorkflowFollowup(
    group: keyof typeof WORKFLOW_FOLLOWUP_GROUPS,
    registration = { describe, it },
    resolveExemption: typeof exemptionFor = exemptionFor,
  ) {
    const { describe, it } = registration;
    describe('mid-turn human follow-up parity — #486', () => {
      for (const backend of BUILT_IN_RUNNER_IDS) {
        for (const row of FOLLOWUP_CRITERIA.filter(row => { return (WORKFLOW_FOLLOWUP_GROUPS[group].rows as readonly string[]).includes(row.id); })) {
          const exemption = resolveExemption(row.id, backend);
          if (exemption) {
            if (!(WORKFLOW_FOLLOWUP_GROUPS[group].modes as readonly string[]).includes('fresh')) continue;
            it(`${backend} ${row.id} exemption — ${exemption.reason}`, cells.exemption(backend, row), 30_000);
            continue;
          }
          const lateStart = row.id === 'H4' || row.id === 'H5';
          const modes = row.id === 'H3' || lateStart ? ['fresh', 'continuation'] as const : ['fresh'] as const;
          for (const mode of modes.filter(mode => { return (WORKFLOW_FOLLOWUP_GROUPS[group].modes as readonly string[]).includes(mode); })) {
            it(`${backend} ${row.id} ${row.name}${modes.length > 1 ? ` (${mode})` : ''}`, cells.row(backend, row, mode, lateStart), 30_000);
          }
        }
      }
    });
  };
}

/** The same cells by name only, for the registration guard. */
export const workflowFollowupCellNames = workflowFollowup({ exemption: collectedOnly, row: collectedOnly });
