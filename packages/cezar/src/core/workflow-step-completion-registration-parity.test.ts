import { it } from 'vitest';
import { STEP_COMPLETION_CRITERIA } from './harness-parity.testkit.ts';
import { PARITY_ROSTER, runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { workflowStepCompletionCellNames } from './workflow-step-completion-rows.testkit.ts';

it('registers every workflow-step-completion case exactly once across its files', () => {
  checkParityRegistration('workflow-step-completion-parity', workflowStepCompletionCellNames,
    PARITY_ROSTER.flatMap(backend => STEP_COMPLETION_CRITERIA.filter(row => runsOn('workflow-step-completion', row.id, backend)).map(row => `${backend} ${row.id}`)), 6);
});
