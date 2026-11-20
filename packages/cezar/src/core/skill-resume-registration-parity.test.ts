import { BUILT_IN_RUNNER_IDS } from '../runners/ids.ts';
import { it } from 'vitest';
import { SKILL_RESUME_CRITERIA } from './harness-parity.testkit.ts';
import { runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { skillResumeCellNames } from './skill-resume-rows.testkit.ts';

it('registers every skill-resume case exactly once across its files', () => {
  checkParityRegistration('skill-resume-parity', skillResumeCellNames,
    BUILT_IN_RUNNER_IDS.flatMap(backend => SKILL_RESUME_CRITERIA.filter(row => runsOn('skill-resume', row.id, backend)).map(row => `${backend} ${row.id}`)), 34);
});
