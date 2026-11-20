import { BUILT_IN_RUNNER_IDS } from '../runners/built-in.ts';
import { it } from 'vitest';
import { SKILL_PROVISION_CRITERIA } from './harness-parity.testkit.ts';
import { runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { skillProvisionCellNames } from './skill-provision-rows.testkit.ts';

it('registers every skill-provision case exactly once across its files', () => {
  checkParityRegistration('skill-provision-parity', skillProvisionCellNames,
    BUILT_IN_RUNNER_IDS.flatMap(backend => SKILL_PROVISION_CRITERIA.filter(row => runsOn('skill-provision', row.id, backend)).map(row => `${backend} ${row.id}`)), 20);
});
