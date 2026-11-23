import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeWaitParity } from '../../workflows/waits-parity-workers-fold.testkit.ts';
import { OmpRunner } from './omp-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { ompRunner } from './definition.ts';

useRunners(onlyRunner(ompRunner, () => new OmpRunner()));
sealTestRunners();

// omp is not the scenario runner: it runs only the wait rows that run on every runner. This file
// runs one group of their parts (WAIT_FOLDS in waits-parity-catalog.testkit.ts, hearsay-tools/cezarion#2991).
describeWaitParity({ runner: ompRunner, part: 'every-runner', fold: 'workers' });
