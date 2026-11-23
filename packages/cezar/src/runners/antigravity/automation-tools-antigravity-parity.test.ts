import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { describeAutomationToolsParity } from '../../workflows/automation-tools-parity.testkit.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
import { onlyRunner, useRunners } from '../../core/runners-under-test.testkit.ts';
import { antigravityRunner } from './definition.ts';

useRunners(onlyRunner(antigravityRunner, () => new AntigravityRunner()));
sealTestRunners();
describeAutomationToolsParity('antigravity');
