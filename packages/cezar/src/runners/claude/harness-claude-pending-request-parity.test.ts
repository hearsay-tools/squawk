import { describeHarnessParity } from '../../core/harness-parity-pending-request.cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { claudeRunner } from './definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));

describeHarnessParity({ runner: 'claude', part: 'pending-request' });
