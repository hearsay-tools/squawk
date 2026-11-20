import { describeAutomationToolsParity } from '../../workflows/automation-tools-parity.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { piRunner } from './definition.ts';

useRunners(onlyRunner(piRunner, () => new PiRunner()));
describeAutomationToolsParity('pi');
