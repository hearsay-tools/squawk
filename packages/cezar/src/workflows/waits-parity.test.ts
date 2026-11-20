import '../core/register-all-runners.testkit.ts';
import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { subagentGuard } from './waits-subagents-parity-cells.testkit.ts';
import { ClaudeCliRunner } from '../runners/claude/claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';

// The single-runner cells drive the Claude wire.
useRunners(onlyRunner(claudeRunner, () => new ClaudeCliRunner()));
// The subagent guard reads every runner's declared facts through the shared code.

// The wait list's criteria guard and single-runner cells; each runner's RUNNER_IDS cells run from
// the semantic part files in `WAIT_PARITY_FILES` and the fold files in `WAIT_FOLDS` (hearsay-tools/cezarion#1301).
describeWaitParity('once');
// The native subagent cells of each runner with a live row run from `waits-<runner>-subagents-parity.test.ts` (hearsay-tools/cezarion#2431).
subagentGuard(runner => `waits-${runner}-subagents-parity.test.ts`);
