import '../runners/fixture/register-fixture-runner.testkit.ts';
import './every-runner.testkit.ts';
import { describeSkillProvisionParity } from './skill-provision-parity.testkit.ts';
import { installSkillProvisionEngine } from './skill-provision-engine.testkit.ts';

installSkillProvisionEngine();
describeSkillProvisionParity('start-and-stop');
