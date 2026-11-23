import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeAutomationToolsParity } from '../../workflows/automation-tools-parity.testkit.ts';
import { OmpRunner } from './omp-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { ompRunner } from './definition.ts';

useRunners(onlyRunner(ompRunner, () => new OmpRunner()));
sealTestRunners();
describeAutomationToolsParity('omp');
