import '../runners/claude/claude-runner.testkit.ts';
import { registerCiFailureGroup } from './ci-wait-failure-parity.testkit.ts';

registerCiFailureGroup('nonfinal-source-retry');
