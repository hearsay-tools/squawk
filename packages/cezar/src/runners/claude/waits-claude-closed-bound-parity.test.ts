import { describeWaitParity } from '../../workflows/waits-parity-closed-cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { claudeRunner } from './definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));

// The closed part runs one file per row family (`FAMILY_FILE_PARTS` in waits-parity-catalog.testkit.ts,
// hearsay-tools/squawk#3683): this file runs its bound rows.
describeWaitParity({ runner: 'claude', part: 'closed', family: 'bound' });
