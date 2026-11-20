import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { it } from 'vitest';
import { AUTONOMOUS_CRITERIA } from './harness-parity.testkit.ts';
import { runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { workflowAutonomousCellNames } from './workflow-autonomous-rows.testkit.ts';

it('registers every workflow-autonomous case exactly once across its files', () => {
  checkParityRegistration('workflow-autonomous-parity', workflowAutonomousCellNames,
    BUILT_IN_RUNNER_IDS.flatMap(backend => AUTONOMOUS_CRITERIA.filter(row => runsOn('workflow-autonomous', row.id, backend)).map(row => `${backend} ${row.id}`)), 19);
});
