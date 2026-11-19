import { subagentCells } from './waits-subagents-parity-cells.testkit.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));

// Squawk's wait on native subagents on the claude wire (hearsay-tools/cezarion#2431).
subagentCells(['claude']);
