import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { registerGroup } from './ci-wait-rerun-parity.testkit.ts';
sealTestRunners();

registerGroup('fresh');
