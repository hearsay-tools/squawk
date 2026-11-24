import { sealTestRunners } from './runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { describeWorkflowAutonomousParity } from './workflow-autonomous-parity.testkit.ts';

sealTestRunners(fixtureRunner);

describeWorkflowAutonomousParity('budget');
