import { describeHarnessParity } from '../../core/harness-parity-owned-workflows.cells.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { PiRunner } from '../pi/pi-runner.ts';
import { onlyRunners, useRunners } from '../../core/runners-under-test.testkit.ts';
import { opencodeRunner } from './definition.ts';
import { piRunner } from '../pi/definition.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in RUNNER_IDS.
useRunners(onlyRunners([[opencodeRunner, () => new OpencodeServerRunner()], [piRunner, () => new PiRunner()]]));

describeHarnessParity({ runner: 'opencode', part: 'owned-workflows' });
