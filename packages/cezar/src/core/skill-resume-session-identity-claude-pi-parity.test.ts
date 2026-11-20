import { describeSkillResumeParity } from './skill-resume-parity.testkit.ts';
import { installSkillResumeEngine } from './skill-resume-engine.testkit.ts';
import { registerRunner } from './runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { piRunner } from '../runners/pi/definition.ts';
import './created-runners.testkit.ts';
registerRunner(claudeRunner);
registerRunner(piRunner);

installSkillResumeEngine();
describeSkillResumeParity('session-identity-claude-pi');
