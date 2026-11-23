import { sealTestRunners } from './runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { describeWorkflowAsk } from './workflow-ask-cells.testkit.ts';
sealTestRunners();

describeWorkflowAsk('continue');
