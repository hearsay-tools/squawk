import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeWaitParity } from '../../workflows/waits-parity-workers-fold.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { piRunner } from './definition.ts';

useRunners(onlyRunner(piRunner, () => new PiRunner()));
sealTestRunners();

// pi is not the scenario runner: it runs only the wait rows that run on every runner. This file
// runs one group of their parts (WAIT_FOLDS in waits-parity-catalog.testkit.ts, hearsay-tools/cezarion#2991).
describeWaitParity({ runner: piRunner, part: 'every-runner', fold: 'workers' });
