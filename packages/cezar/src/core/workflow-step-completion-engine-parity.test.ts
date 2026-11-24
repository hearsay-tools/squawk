import { sealTestRunners } from './runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { describeWorkflowStepCompletionParity } from './workflow-step-completion-parity.testkit.ts';

sealTestRunners(fixtureRunner);

describeWorkflowStepCompletionParity('engine');
