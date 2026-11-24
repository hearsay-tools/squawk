import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { registerGroup } from './ci-wait-rerun-parity.testkit.ts';

sealTestRunners(fixtureRunner);

registerGroup('fresh');
registerGroup('recovered');
