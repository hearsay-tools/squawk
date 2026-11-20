import { subagentCells } from '../../workflows/waits-subagents-parity-cells.testkit.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { opencodeRunner } from './definition.ts';

useRunners(onlyRunner(opencodeRunner, () => new OpencodeServerRunner()));

// Squawk's wait on native subagents on the opencode wire (hearsay-tools/cezarion#2431).
subagentCells([opencodeRunner]);
