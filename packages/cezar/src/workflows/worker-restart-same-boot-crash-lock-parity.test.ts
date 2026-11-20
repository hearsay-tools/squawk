import '../runners/claude/claude-runner.testkit.ts';
import { registerRestartGroup } from './worker-restart-parity.testkit.ts';

registerRestartGroup('same-boot-crash-lock');
