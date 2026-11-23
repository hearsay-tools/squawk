import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { registerGroup } from './ci-wait-conflict-parity.testkit.ts';
sealTestRunners();

registerGroup('recovered');
