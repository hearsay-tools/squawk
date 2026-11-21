import { AntigravityRunner } from './antigravity-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { describeNativeSkillTriggers } from '../../core/runner-skill-trigger.testkit.ts';
import { antigravityRunner } from './definition.ts';
useRunners(onlyRunner(antigravityRunner, () => new AntigravityRunner()));
describeNativeSkillTriggers('antigravity');
