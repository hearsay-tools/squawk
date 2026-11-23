import { sealTestRunners } from './runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { describeWorkflowAutonomousParity } from './workflow-autonomous-parity.testkit.ts';
sealTestRunners();

describeWorkflowAutonomousParity('tool-parking');
