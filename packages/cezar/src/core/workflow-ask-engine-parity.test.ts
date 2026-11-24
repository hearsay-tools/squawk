import { sealTestRunners } from './runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { describeWorkflowAsk } from './workflow-ask-cells.testkit.ts';

sealTestRunners(fixtureRunner);

describeWorkflowAsk('engine');
