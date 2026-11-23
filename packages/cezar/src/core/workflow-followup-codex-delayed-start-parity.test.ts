import { sealTestRunners } from './runner-registry.testkit.ts';
import { describeCodexDelayedStart } from './workflow-followup-cells.testkit.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import './created-runners.testkit.ts';

sealTestRunners(codexRunner);

describeCodexDelayedStart();
