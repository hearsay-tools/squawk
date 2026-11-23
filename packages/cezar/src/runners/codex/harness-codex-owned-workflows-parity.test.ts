import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeHarnessParity } from '../../core/harness-parity-owned-workflows.cells.testkit.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { OpencodeServerRunner } from '../opencode/opencode-server-runner.ts';
import { onlyRunners, useRunners } from '../../core/runners-under-test.testkit.ts';
import { codexRunner } from './definition.ts';
import { opencodeRunner } from '../opencode/definition.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in BUILT_IN_RUNNER_IDS.
useRunners(onlyRunners([[codexRunner, () => new CodexAppServerRunner()], [opencodeRunner, () => new OpencodeServerRunner()]]));
sealTestRunners();

describeHarnessParity({ runner: codexRunner, part: 'owned-workflows' });
