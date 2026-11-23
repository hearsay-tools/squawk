import { sealSkillResumeRunners } from './skill-resume-runners.testkit.ts';
import { describeSkillResumeParity } from './skill-resume-parity.testkit.ts';
import { installSkillResumeEngine } from './skill-resume-engine.testkit.ts';
import './created-runners.testkit.ts';

await sealSkillResumeRunners('session-identity-claude-pi');

installSkillResumeEngine();
describeSkillResumeParity('session-identity-claude-pi');
