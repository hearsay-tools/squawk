import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { registerRestartGroup } from './worker-restart-parity.testkit.ts';
sealTestRunners();

registerRestartGroup('starting-proof');
