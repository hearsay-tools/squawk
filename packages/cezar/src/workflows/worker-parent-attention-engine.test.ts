import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { registerAttentionGroup } from './worker-parent-attention.testkit.ts';

sealTestRunners(fixtureRunner);

registerAttentionGroup('fresh-ordinary-progress');
registerAttentionGroup('continued-ordinary-progress');
registerAttentionGroup('fresh-spawn-ask');
registerAttentionGroup('continued-spawn-ask');
registerAttentionGroup('capacity-wake');
registerAttentionGroup('restart-human-ask');
