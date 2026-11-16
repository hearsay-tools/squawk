import { PiRunner } from './pi-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { describeNativeSkillTriggers } from './runner-skill-trigger.testkit.ts';

useRunners(onlyRunner('pi', () => new PiRunner()));
describeNativeSkillTriggers('pi');
