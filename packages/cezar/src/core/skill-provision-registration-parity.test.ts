import { it } from 'vitest';
import { SKILL_PROVISION_CRITERIA } from './harness-parity.testkit.ts';
import { PARITY_ROSTER, runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { skillProvisionCellNames } from './skill-provision-rows.testkit.ts';

it('registers every skill-provision case exactly once across its files', () => {
  checkParityRegistration('skill-provision-parity', skillProvisionCellNames,
    PARITY_ROSTER.flatMap(backend => SKILL_PROVISION_CRITERIA.filter(row => runsOn('skill-provision', row.id, backend)).map(row => `${backend} ${row.id}`)), 8, {
      'unconverted opening command keeps character zero on the native wire': runner => runner === 'claude',
      'typed opening skill carries session context on the native wire': runner => runner === 'claude',
    });
});
