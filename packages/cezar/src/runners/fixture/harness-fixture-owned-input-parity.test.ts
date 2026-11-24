import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeHarnessParity } from '../../core/harness-parity-owned-input.cells.testkit.ts';
import './fixture-runner.testkit.ts';
import { fixtureRunner } from './definition.testkit.ts';

sealTestRunners(fixtureRunner);

describeHarnessParity({ runner: fixtureRunner, part: 'owned-input' });
