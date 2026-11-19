import { describeWaitParity } from './waits-parity-refusal-cells.testkit.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));

describeWaitParity({ runner: 'claude', part: 'refusal' });
