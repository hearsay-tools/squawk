import { sealTestRunners } from './runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { describeWorkflowTimeoutParity } from './workflow-timeout-parity.testkit.ts';
import { installWorkflowTimeoutEngine } from './workflow-timeout-engine.testkit.ts';
sealTestRunners();

installWorkflowTimeoutEngine();
describeWorkflowTimeoutParity('defaults');
