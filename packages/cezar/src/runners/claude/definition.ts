import { defineRunner } from '../../core/runner-definition.ts';
import { CLAUDE_FACTS } from './facts.ts';

/** The Claude runner. */
export const claudeRunner = defineRunner({
  id: 'claude',
  facts: CLAUDE_FACTS,
  loadAdapter: async () => new (await import('../../core/claude-cli-runner.ts')).ClaudeCliRunner(),
});
