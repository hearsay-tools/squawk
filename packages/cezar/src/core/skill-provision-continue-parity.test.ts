import { sealTestRunners } from './runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { describeSkillProvisionParity } from './skill-provision-parity.testkit.ts';
sealTestRunners();

describeSkillProvisionParity('continue');
