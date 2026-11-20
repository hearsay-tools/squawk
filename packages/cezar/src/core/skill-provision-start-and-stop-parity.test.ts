import { describeSkillProvisionParity } from './skill-provision-parity.testkit.ts';
import { installSkillProvisionEngine } from './skill-provision-engine.testkit.ts';

installSkillProvisionEngine();
describeSkillProvisionParity('start-and-stop');
