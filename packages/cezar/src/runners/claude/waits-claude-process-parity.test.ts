import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeWaitParity } from '../../workflows/waits-parity-process-cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { claudeRunner } from './definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));
sealTestRunners();

// The wait list's process-wait cells on the claude wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: claudeRunner, part: 'process' });
