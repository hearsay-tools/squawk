import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { describeNativeSkillTriggers } from './runner-skill-trigger.testkit.ts';

useRunners(onlyRunner('opencode', () => new OpencodeServerRunner()));
describeNativeSkillTriggers('opencode');
