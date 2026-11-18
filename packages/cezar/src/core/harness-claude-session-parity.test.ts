import { describeHarnessParity } from './harness-parity-session.cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));

describeHarnessParity({ runner: 'claude', part: 'session' });
