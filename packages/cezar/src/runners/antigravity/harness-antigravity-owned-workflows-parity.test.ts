import { describeHarnessParity } from '../../core/harness-parity-owned-workflows.cells.testkit.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
import { OmpRunner } from '../omp/omp-runner.ts';
import { onlyRunners, useRunners } from '../../core/runners-under-test.testkit.ts';
import { antigravityRunner } from './definition.ts';
import { ompRunner } from '../omp/definition.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in BUILT_IN_RUNNER_IDS.
useRunners(onlyRunners([[antigravityRunner, () => new AntigravityRunner()], [ompRunner, () => new OmpRunner()]]));

describeHarnessParity({ runner: antigravityRunner, part: 'owned-workflows' });
