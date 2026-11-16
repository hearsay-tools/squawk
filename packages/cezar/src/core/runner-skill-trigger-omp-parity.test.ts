import { OmpRunner } from './omp-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { describeNativeSkillTriggers } from './runner-skill-trigger.testkit.ts';

useRunners(onlyRunner('omp', () => new OmpRunner()));
describeNativeSkillTriggers('omp');
