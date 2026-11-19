import { CodexAppServerRunner } from '../runners/codex/codex-app-server-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { describeNativeSkillTriggers } from './runner-skill-trigger.testkit.ts';
import { codexRunner } from '../runners/codex/definition.ts';

useRunners(onlyRunner(codexRunner, () => new CodexAppServerRunner()));
describeNativeSkillTriggers('codex');
