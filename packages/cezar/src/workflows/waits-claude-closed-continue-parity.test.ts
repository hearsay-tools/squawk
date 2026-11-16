import { describeWaitParity } from './waits-parity-closed-cells.testkit.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('claude', () => new ClaudeCliRunner()));

// The closed part runs one file per row family (`FAMILY_FILE_PARTS` in waits-parity-catalog.testkit.ts,
// hearsay-tools/squawk#3683): this file runs its continue rows.
describeWaitParity({ runner: 'claude', part: 'closed', family: 'continue' });
