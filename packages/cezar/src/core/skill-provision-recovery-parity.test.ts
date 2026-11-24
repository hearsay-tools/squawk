import { sealTestRunners } from './runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { describeSkillProvisionParity } from './skill-provision-parity.testkit.ts';
sealTestRunners(fixtureRunner);

describeSkillProvisionParity('recovery');
