import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { registerCiFailureGroup } from './ci-wait-failure-parity.testkit.ts';

sealTestRunners(fixtureRunner);

registerCiFailureGroup('nonfinal-passed');
registerCiFailureGroup('nonfinal-failed');
registerCiFailureGroup('nonfinal-restarted');
registerCiFailureGroup('nonfinal-source-retry');
