import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';
import { it } from 'vitest';
import { WORKFLOW_TIMEOUT_CRITERIA } from './harness-parity.testkit.ts';
import { runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { workflowTimeoutCellNames } from './workflow-timeout-rows.testkit.ts';

it('registers every workflow-timeout case exactly once across its files', () => {
  checkParityRegistration('workflow-timeout-parity', workflowTimeoutCellNames,
    BUILT_IN_RUNNER_IDS.flatMap(backend => WORKFLOW_TIMEOUT_CRITERIA.filter(row => runsOn('workflow-timeout', row.id, backend)).map(row => `${backend} ${row.id}`)), 15);
});
