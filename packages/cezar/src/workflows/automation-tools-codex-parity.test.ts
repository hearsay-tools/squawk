import { describeAutomationToolsParity } from './automation-tools-parity.testkit.ts';
import { CodexAppServerRunner } from '../core/codex-app-server-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';
import { codexRunner } from '../runners/codex/definition.ts';

useRunners(onlyRunner(codexRunner, () => new CodexAppServerRunner()));
describeAutomationToolsParity('codex');
