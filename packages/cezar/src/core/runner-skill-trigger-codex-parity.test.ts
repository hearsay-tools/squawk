import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { describeNativeSkillTriggers } from './runner-skill-trigger.testkit.ts';

useRunners(onlyRunner('codex', () => new CodexAppServerRunner()));
describeNativeSkillTriggers('codex');
