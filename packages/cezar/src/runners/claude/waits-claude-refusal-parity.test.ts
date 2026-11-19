import { describeWaitParity } from '../../workflows/waits-parity-refusal-cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { claudeRunner } from './definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));

describeWaitParity({ runner: 'claude', part: 'refusal' });
