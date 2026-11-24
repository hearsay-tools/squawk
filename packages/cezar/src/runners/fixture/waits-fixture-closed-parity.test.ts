import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeWaitParity } from '../../workflows/waits-parity-shared-closed-fold.testkit.ts';
import './fixture-runner.testkit.ts';
import { fixtureRunner } from './definition.testkit.ts';

sealTestRunners(fixtureRunner);

describeWaitParity({ runner: fixtureRunner, part: 'shared', fold: 'closed' });
