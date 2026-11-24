import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { registerRestartGroup } from './worker-restart-parity.testkit.ts';

sealTestRunners(fixtureRunner);

registerRestartGroup('starting-proof');
registerRestartGroup('destroy-absent-ledger');
registerRestartGroup('destroy-incomplete-ledger');
registerRestartGroup('same-boot-crash-lock');
