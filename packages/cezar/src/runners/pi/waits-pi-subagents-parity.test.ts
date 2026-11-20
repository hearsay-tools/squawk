import { subagentCells } from '../../workflows/waits-subagents-parity-cells.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { piRunner } from './definition.ts';

useRunners(onlyRunner(piRunner, () => new PiRunner()));

// Squawk's wait on native subagents on the pi wire (hearsay-tools/cezarion#2431).
subagentCells([piRunner]);
