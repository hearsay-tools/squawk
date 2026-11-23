import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeWaitParity } from '../../workflows/waits-parity-entries-refusals-fold.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { opencodeRunner } from './definition.ts';

useRunners(onlyRunner(opencodeRunner, () => new OpencodeServerRunner()));
sealTestRunners();

// opencode is not the scenario runner: it runs only the wait rows that run on every runner. This file
// runs one group of their parts (WAIT_FOLDS in waits-parity-catalog.testkit.ts, hearsay-tools/cezarion#2991).
describeWaitParity({ runner: opencodeRunner, part: 'every-runner', fold: 'entries-refusals' });
