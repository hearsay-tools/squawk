import { it } from 'vitest';
import { WORKFLOW_TIMEOUT_CRITERIA } from './harness-parity.testkit.ts';
import { PARITY_ROSTER, runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { workflowTimeoutCellNames } from './workflow-timeout-rows.testkit.ts';

it('registers every workflow-timeout case exactly once across its files', () => {
  checkParityRegistration('workflow-timeout-parity', workflowTimeoutCellNames,
    PARITY_ROSTER.flatMap(backend => WORKFLOW_TIMEOUT_CRITERIA.filter(row => runsOn('workflow-timeout', row.id, backend)).map(row => `${backend} ${row.id}`)), 7);
});
