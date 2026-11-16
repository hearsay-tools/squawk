import { describeAutomationToolsParity } from './automation-tools-parity.testkit.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('claude', () => new ClaudeCliRunner()));
describeAutomationToolsParity('claude');
