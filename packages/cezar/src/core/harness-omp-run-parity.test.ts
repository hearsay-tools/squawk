import { describeHarnessParity } from './harness-parity-run.cells.testkit.ts';
import { OmpRunner } from './omp-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { ompRunner } from '../runners/omp/definition.ts';

useRunners(onlyRunner(ompRunner, () => new OmpRunner()));

describeHarnessParity({ runner: 'omp', part: 'run' });
