import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { subagentCells } from '../../workflows/waits-subagents-parity-cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { claudeRunner } from './definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));
sealTestRunners();

// Squawk's wait on native subagents on the claude wire (hearsay-tools/cezarion#2431).
subagentCells([claudeRunner]);
