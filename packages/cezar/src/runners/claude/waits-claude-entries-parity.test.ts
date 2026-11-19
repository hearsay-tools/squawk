import { describeWaitParity } from '../../workflows/waits-parity-entries-cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { claudeRunner } from './definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));

// The wait list's RUNNER_IDS turn-end entry cells on the claude wire (hearsay-tools/cezarion#1525).
describeWaitParity({ runner: 'claude', part: 'entries' });
