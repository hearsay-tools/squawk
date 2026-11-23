import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import '../runners/claude/claude-runner.testkit.ts';
import { registerMonitoringPartition } from './monitoring-turn-rows.testkit.ts';
sealTestRunners();

registerMonitoringPartition('ask-precedence-question-continuation');
