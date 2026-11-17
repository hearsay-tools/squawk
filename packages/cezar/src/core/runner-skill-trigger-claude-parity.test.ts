import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { describeNativeSkillTriggers } from './runner-skill-trigger.testkit.ts';

useRunners(onlyRunner('claude', () => new ClaudeCliRunner()));
describeNativeSkillTriggers('claude');
