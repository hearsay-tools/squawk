import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { registerCiFailureGroup } from './ci-wait-failure-parity.testkit.ts';

sealTestRunners(fixtureRunner);

registerCiFailureGroup('final-recovery');
registerCiFailureGroup('restart-acknowledgement');
registerCiFailureGroup('restart-queued-tail');
