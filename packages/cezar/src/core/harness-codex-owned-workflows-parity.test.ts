import { describeHarnessParity } from './harness-parity-owned-workflows.cells.testkit.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { onlyRunners, useRunners } from './runners-under-test.testkit.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';

// R14 runs a mixed-runner chain: its second step is the next runner in RUNNER_IDS.
useRunners(onlyRunners([[codexRunner, () => new CodexAppServerRunner()], [opencodeRunner, () => new OpencodeServerRunner()]]));

describeHarnessParity({ runner: 'codex', part: 'owned-workflows' });
