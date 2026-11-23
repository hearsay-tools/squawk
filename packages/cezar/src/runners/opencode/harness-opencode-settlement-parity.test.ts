import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeHarnessParity } from '../../core/harness-parity-settlement.cells.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { opencodeRunner } from './definition.ts';

useRunners(onlyRunner(opencodeRunner, () => new OpencodeServerRunner()));
sealTestRunners();

describeHarnessParity({ runner: opencodeRunner, part: 'settlement' });
