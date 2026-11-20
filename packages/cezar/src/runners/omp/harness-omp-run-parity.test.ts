import { describeHarnessParity } from '../../core/harness-parity-run.cells.testkit.ts';
import { OmpRunner } from './omp-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { ompRunner } from './definition.ts';

useRunners(onlyRunner(ompRunner, () => new OmpRunner()));

describeHarnessParity({ runner: ompRunner, part: 'run' });
