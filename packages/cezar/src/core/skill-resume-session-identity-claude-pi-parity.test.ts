import { describeSkillResumeParity } from './skill-resume-parity.testkit.ts';
import { installSkillResumeEngine } from './skill-resume-engine.testkit.ts';

installSkillResumeEngine();
describeSkillResumeParity('session-identity-claude-pi');
