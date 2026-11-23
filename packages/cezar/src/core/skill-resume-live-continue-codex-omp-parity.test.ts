import { sealTestRunners } from './runner-registry.testkit.ts';
import { describeSkillResumeParity } from './skill-resume-parity.testkit.ts';
import { installSkillResumeEngine } from './skill-resume-engine.testkit.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import { ompRunner } from '../runners/omp/definition.ts';
import './created-runners.testkit.ts';

sealTestRunners(codexRunner, ompRunner);

installSkillResumeEngine();
describeSkillResumeParity('live-continue-codex-omp');
