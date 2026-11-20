import { describeHarnessParity } from '../../core/harness-parity-owned-workflows.cells.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { OmpRunner } from '../omp/omp-runner.ts';
import { onlyRunners, useRunners } from '../../core/runners-under-test.testkit.ts';
import { piRunner } from './definition.ts';
import { ompRunner } from '../omp/definition.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in RUNNER_IDS.
useRunners(onlyRunners([[piRunner, () => new PiRunner()], [ompRunner, () => new OmpRunner()]]));

describeHarnessParity({ runner: piRunner, part: 'owned-workflows' });
