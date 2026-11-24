import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeHarnessParity } from '../../core/harness-parity-ownership.cells.testkit.ts';
import './fixture-runner.testkit.ts';
import { fixtureRunner } from './definition.testkit.ts';

sealTestRunners(fixtureRunner);

describeHarnessParity({ runner: fixtureRunner, part: 'ownership' });
