import { describeHarnessParity } from '../../core/harness-parity-owned-workflows.cells.testkit.ts';
import { OmpRunner } from './omp-runner.ts';
import { ClaudeCliRunner } from '../claude/claude-cli-runner.ts';
import { onlyRunners, useRunners } from '../../core/runners-under-test.testkit.ts';
import { ompRunner } from './definition.ts';
import { claudeRunner } from '../claude/definition.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in BUILT_IN_RUNNER_IDS.
useRunners(onlyRunners([[ompRunner, () => new OmpRunner()], [claudeRunner, () => new ClaudeCliRunner()]]));

describeHarnessParity({ runner: ompRunner, part: 'owned-workflows' });
