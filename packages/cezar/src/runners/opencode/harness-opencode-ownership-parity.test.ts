import { describeHarnessParity } from '../../core/harness-parity-ownership.cells.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { opencodeRunner } from './definition.ts';

useRunners(onlyRunner(opencodeRunner, () => new OpencodeServerRunner()));

describeHarnessParity({ runner: opencodeRunner, part: 'ownership' });
