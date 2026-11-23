import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { registerCiFailureGroup } from './ci-wait-failure-parity.testkit.ts';
sealTestRunners();

registerCiFailureGroup('restart-queued-tail');
