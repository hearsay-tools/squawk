import { sealTestRunners } from './runner-registry.testkit.ts';
import { describeSkillResumeParity } from './skill-resume-parity.testkit.ts';
import { installSkillResumeEngine } from './skill-resume-engine.testkit.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { piRunner } from '../runners/pi/definition.ts';
import './created-runners.testkit.ts';

sealTestRunners(claudeRunner, piRunner);

installSkillResumeEngine();
describeSkillResumeParity('live-continue-claude-pi');
