import { sealTestRunners } from './runner-registry.testkit.ts';
import { describeCodexReverseOrder } from './workflow-followup-cells.testkit.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import './created-runners.testkit.ts';

sealTestRunners(codexRunner);

describeCodexReverseOrder();
