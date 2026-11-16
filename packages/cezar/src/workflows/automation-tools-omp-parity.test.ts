import { describeAutomationToolsParity } from './automation-tools-parity.testkit.ts';
import { OmpRunner } from '../core/omp-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('omp', () => new OmpRunner()));
describeAutomationToolsParity('omp');
