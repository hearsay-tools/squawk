import '../runners/fixture/register-fixture-runner.testkit.ts';
import { it } from 'vitest';
import { AUTONOMOUS_CRITERIA } from './harness-parity.testkit.ts';
import { PARITY_ROSTER, runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { workflowAutonomousCellNames } from './workflow-autonomous-rows.testkit.ts';

it('registers every workflow-autonomous case exactly once across its files', () => {
  checkParityRegistration('workflow-autonomous-parity', workflowAutonomousCellNames,
    PARITY_ROSTER.flatMap(backend => AUTONOMOUS_CRITERIA.filter(row => runsOn('workflow-autonomous', row.id, backend)).map(row => `${backend} ${row.id}`)), 19);
});
