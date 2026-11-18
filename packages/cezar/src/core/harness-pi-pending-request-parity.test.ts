import { describeHarnessParity } from './harness-parity-pending-request.cells.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';
import { piRunner } from '../runners/pi/definition.ts';

useRunners(onlyRunner(piRunner, () => new PiRunner()));

describeHarnessParity({ runner: 'pi', part: 'pending-request' });
