import { describeAutomationToolsParity } from './automation-tools-parity.testkit.ts';
import { OmpRunner } from '../runners/omp/omp-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';
import { ompRunner } from '../runners/omp/definition.ts';

useRunners(onlyRunner(ompRunner, () => new OmpRunner()));
describeAutomationToolsParity('omp');
