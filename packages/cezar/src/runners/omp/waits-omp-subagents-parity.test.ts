import { subagentCells } from '../../workflows/waits-subagents-parity-cells.testkit.ts';
import { OmpRunner } from './omp-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { ompRunner } from './definition.ts';

useRunners(onlyRunner(ompRunner, () => new OmpRunner()));

// Squawk's wait on native subagents on the omp wire (hearsay-tools/cezarion#2431).
subagentCells(['omp']);
