import { BUILT_IN_RUNNER_IDS } from './built-in-runner-ids.testkit.ts';
import { it } from 'vitest';
import { SKILL_RESUME_CRITERIA } from './harness-parity.testkit.ts';
import { runsOn } from './parity-classes.testkit.ts';
import { checkParityRegistration } from './parity-partition.testkit.ts';
import { factsWhere } from './runner-fact-rows.testkit.ts';
import { skillResumeCellNames } from './skill-resume-rows.testkit.ts';

it('registers every skill-resume case exactly once across its files', () => {
  checkParityRegistration('skill-resume-parity', skillResumeCellNames,
    BUILT_IN_RUNNER_IDS.flatMap(backend => SKILL_RESUME_CRITERIA.filter(row => runsOn('skill-resume', row.id, backend)).map(row => `${backend} ${row.id}`)), 9, {
      // The cell runs where the declared resume mode puts the system prompt in the thread.
      'fresh-session continuation includes the skill': runner => factsWhere(facts => facts.systemPromptOnResume === 'in-thread').includes(runner),
    });
});
