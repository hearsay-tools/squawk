import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { describeSessionContext, SESSION_CONTEXT_GROUPS } from './session-context-cells.testkit.ts';
sealTestRunners();

describeSessionContext(SESSION_CONTEXT_GROUPS.worker);
