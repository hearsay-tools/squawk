import { sealTestRunners } from './runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { describeWorkflowTimeoutParity } from './workflow-timeout-parity.testkit.ts';
import { installWorkflowTimeoutEngine } from './workflow-timeout-engine.testkit.ts';

sealTestRunners(fixtureRunner);

installWorkflowTimeoutEngine();
describeWorkflowTimeoutParity('engine');
