import { describeAutomationToolsParity } from './automation-tools-parity.testkit.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));
describeAutomationToolsParity('claude');
