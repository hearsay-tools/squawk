import { describeSkillResumeParity } from './skill-resume-parity.testkit.ts';
import { installSkillResumeEngine } from './skill-resume-engine.testkit.ts';
import { registerRunner } from './runner-registry.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { ompRunner } from '../runners/omp/definition.ts';
import './created-runners.testkit.ts';
registerRunner(codexRunner);
registerRunner(ompRunner);

installSkillResumeEngine();
describeSkillResumeParity('session-identity-codex-omp');
