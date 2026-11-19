import { describeHarnessParity } from '../../core/harness-parity-startup.cells.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { piRunner } from './definition.ts';

useRunners(onlyRunner(piRunner, () => new PiRunner()));

describeHarnessParity({ runner: 'pi', part: 'startup' });
