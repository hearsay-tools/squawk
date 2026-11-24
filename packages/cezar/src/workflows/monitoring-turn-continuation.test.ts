import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/fixture/fixture-runner.testkit.ts';
import { fixtureRunner } from '../runners/fixture/definition.testkit.ts';
import { registerMonitoringPartition } from './monitoring-turn-rows.testkit.ts';

sealTestRunners(fixtureRunner);

registerMonitoringPartition('continuation');
