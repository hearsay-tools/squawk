import { describeHarnessParity } from './harness-parity-owned-workflows.cells.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { PiRunner } from './pi-runner.ts';
import { onlyRunners, useRunners } from './runners-under-test.testkit.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';
import { piRunner } from '../runners/pi/definition.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in RUNNER_IDS.
useRunners(onlyRunners([[opencodeRunner, () => new OpencodeServerRunner()], [piRunner, () => new PiRunner()]]));

describeHarnessParity({ runner: 'opencode', part: 'owned-workflows' });
