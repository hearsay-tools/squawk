import { describeHarnessParity } from './harness-parity-owned-workflows.cells.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { OmpRunner } from './omp-runner.ts';
import { onlyRunners, useRunners } from './runners-under-test.testkit.ts';
import { piRunner } from '../runners/pi/definition.ts';
import { ompRunner } from '../runners/omp/definition.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in RUNNER_IDS.
useRunners(onlyRunners([[piRunner, () => new PiRunner()], [ompRunner, () => new OmpRunner()]]));

describeHarnessParity({ runner: 'pi', part: 'owned-workflows' });
