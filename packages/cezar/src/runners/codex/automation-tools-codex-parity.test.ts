import { describeAutomationToolsParity } from '../../workflows/automation-tools-parity.testkit.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { codexRunner } from './definition.ts';

useRunners(onlyRunner(codexRunner, () => new CodexAppServerRunner()));
describeAutomationToolsParity('codex');
