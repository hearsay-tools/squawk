import { describeCodexDelayedStart } from './workflow-followup-cells.testkit.ts';
import { registerRunner } from './runner-registry.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import './created-runners.testkit.ts';
registerRunner(codexRunner);

describeCodexDelayedStart();
