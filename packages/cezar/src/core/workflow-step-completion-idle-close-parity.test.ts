import { sealTestRunners } from './runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { describeWorkflowStepCompletionParity } from './workflow-step-completion-parity.testkit.ts';
sealTestRunners();

describeWorkflowStepCompletionParity('idle-close');
