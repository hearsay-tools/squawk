import { describeAutomationToolsParity } from './automation-tools-parity.testkit.ts';
import { PiRunner } from '../core/pi-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';
import { piRunner } from '../runners/pi/definition.ts';

useRunners(onlyRunner(piRunner, () => new PiRunner()));
describeAutomationToolsParity('pi');
