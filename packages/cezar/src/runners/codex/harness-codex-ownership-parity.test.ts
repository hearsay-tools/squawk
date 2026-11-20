import { describeHarnessParity } from '../../core/harness-parity-ownership.cells.testkit.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { codexRunner } from './definition.ts';

useRunners(onlyRunner(codexRunner, () => new CodexAppServerRunner()));

describeHarnessParity({ runner: codexRunner, part: 'ownership' });
