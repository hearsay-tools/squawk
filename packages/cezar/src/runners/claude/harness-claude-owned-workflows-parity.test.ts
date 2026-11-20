import { describeHarnessParity } from '../../core/harness-parity-owned-workflows.cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from '../codex/codex-app-server-runner.ts';
import { onlyRunners, useRunners } from '../../core/runners-under-test.testkit.ts';
import { claudeRunner } from './definition.ts';
import { codexRunner } from '../codex/definition.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in BUILT_IN_RUNNER_IDS.
useRunners(onlyRunners([[claudeRunner, () => new ClaudeCliRunner()], [codexRunner, () => new CodexAppServerRunner()]]));

describeHarnessParity({ runner: claudeRunner, part: 'owned-workflows' });
