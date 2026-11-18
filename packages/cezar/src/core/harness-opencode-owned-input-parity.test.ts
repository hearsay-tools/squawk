import { describeHarnessParity } from './harness-parity-owned-input.cells.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';

useRunners(onlyRunner(opencodeRunner, () => new OpencodeServerRunner()));

describeHarnessParity({ runner: 'opencode', part: 'owned-input' });
