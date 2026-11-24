import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeWaitParity } from '../../workflows/waits-parity-shared-completion-fold.testkit.ts';
import './fixture-runner.testkit.ts';
import { fixtureRunner } from './definition.testkit.ts';

sealTestRunners(fixtureRunner);

describeWaitParity({ runner: fixtureRunner, part: 'shared', fold: 'completion' });
