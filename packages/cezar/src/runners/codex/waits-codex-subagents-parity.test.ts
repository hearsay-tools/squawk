import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { subagentCells } from '../../workflows/waits-subagents-parity-cells.testkit.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { codexRunner } from './definition.ts';

useRunners(onlyRunner(codexRunner, () => new CodexAppServerRunner()));
sealTestRunners();

// Squawk's wait on native subagents on the codex wire (hearsay-tools/cezarion#2431).
subagentCells([codexRunner]);
