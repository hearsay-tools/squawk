import { describeWaitParity } from '../../workflows/waits-parity-deadlines-cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { claudeRunner } from './definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));

// The wait list's deadline-accounting cells on the claude wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'claude', part: 'deadlines' });
