import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeHarnessParity } from '../../core/harness-parity-session.cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { claudeRunner } from './definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));
sealTestRunners();

describeHarnessParity({ runner: claudeRunner, part: 'session' });
