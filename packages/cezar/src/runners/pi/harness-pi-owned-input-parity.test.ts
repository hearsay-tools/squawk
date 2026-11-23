import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeHarnessParity } from '../../core/harness-parity-owned-input.cells.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { piRunner } from './definition.ts';

useRunners(onlyRunner(piRunner, () => new PiRunner()));
sealTestRunners();

describeHarnessParity({ runner: piRunner, part: 'owned-input' });
