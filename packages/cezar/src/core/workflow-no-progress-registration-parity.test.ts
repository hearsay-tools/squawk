import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';
import { it } from 'vitest';
import { NO_PROGRESS_CRITERIA } from './harness-parity.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { workflowNoProgressCellNames } from './workflow-no-progress-rows.testkit.ts';

it('registers every workflow-no-progress case exactly once across its files', () => {
  checkParityRegistration('workflow-no-progress-parity', workflowNoProgressCellNames,
    BUILT_IN_RUNNER_IDS.flatMap(backend => NO_PROGRESS_CRITERIA.map(row => `${backend} ${row.id}`)), 40);
});
