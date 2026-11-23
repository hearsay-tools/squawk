import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { registerGroup } from './worker-reboot-parity.testkit.ts';
sealTestRunners();

registerGroup('collect');
