import { registerDelegationIntegrationGroup } from './delegation-integration.testkit.ts';
import { registerRunner } from '../core/runner-registry.ts';
import { claudeRunner } from '../runners/claude/definition.ts';
import { codexRunner } from '../runners/codex/definition.ts';
import '../core/created-runners.testkit.ts';
registerRunner(claudeRunner);
registerRunner(codexRunner);

registerDelegationIntegrationGroup('parent-cancellation');
