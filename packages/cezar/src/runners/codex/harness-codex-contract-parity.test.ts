import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeHarnessParity } from '../../core/harness-parity-contract.cells.testkit.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { codexRunner } from './definition.ts';

useRunners(onlyRunner(codexRunner, () => new CodexAppServerRunner()));
sealTestRunners();

describeHarnessParity({ runner: codexRunner, part: 'contract' });
