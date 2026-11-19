import { describeAutomationToolsParity } from './automation-tools-parity.testkit.ts';
import { OpencodeServerRunner } from '../runners/opencode/opencode-server-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';

useRunners(onlyRunner(opencodeRunner, () => new OpencodeServerRunner()));
describeAutomationToolsParity('opencode');
