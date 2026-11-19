import { defineRunner } from '../../core/runner-definition.ts';
import { CLAUDE_FACTS } from './facts.ts';
import { CLAUDE_MODELS } from './models.ts';

/** The Claude runner. */
export const claudeRunner = defineRunner({
  id: 'claude',
  facts: CLAUDE_FACTS,
  loadAdapter: async () => new (await import('../../core/claude-cli-runner.ts')).ClaudeCliRunner(),
  models: {
    ...CLAUDE_MODELS,
    loadSettings: async () => (await import('../../agent-config/model-settings/claude.ts')).claudeModelSettingsStrategy,
  },
});
