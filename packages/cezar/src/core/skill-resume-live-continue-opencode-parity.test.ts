import { sealTestRunners } from './runner-registry.testkit.ts';
import { describeSkillResumeParity } from './skill-resume-parity.testkit.ts';
import { installSkillResumeEngine } from './skill-resume-engine.testkit.ts';
import { opencodeRunner } from '../runners/opencode/definition.ts';
import './created-runners.testkit.ts';

sealTestRunners(opencodeRunner);

installSkillResumeEngine();
describeSkillResumeParity('live-continue-opencode');
