import './every-runner.testkit.ts';
import { describeSkillResumeParity } from './skill-resume-parity.testkit.ts';
import { installSkillResumeEngine } from './skill-resume-engine.testkit.ts';

installSkillResumeEngine();
describeSkillResumeParity('wire-and-fallback-engine');
