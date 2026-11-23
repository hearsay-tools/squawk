import { sealTestRunners } from '../core/runner-registry.testkit.ts';
import { registerDelegationIntegrationGroup } from './delegation-integration.testkit.ts';
import { workerCleanups } from '../delegation/worker-cleanup.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import '../core/created-runners.testkit.ts';

sealTestRunners(claudeRunner, codexRunner);

registerDelegationIntegrationGroup('reviewed-integration', workerCleanups());
