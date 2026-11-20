import { describeSkillResumeParity } from './skill-resume-parity.testkit.ts';
import { installSkillResumeEngine } from './skill-resume-engine.testkit.ts';
import { registerRunner } from './runner-registry.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';
import './created-runners.testkit.ts';
registerRunner(opencodeRunner);

installSkillResumeEngine();
describeSkillResumeParity('session-identity-opencode');
