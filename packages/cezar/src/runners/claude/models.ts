import type { RunnerModelData } from '../../core/runner-definition.ts';

/** The Claude runner's model data. Data only: importing it loads no adapter. */
export const CLAUDE_MODELS: RunnerModelData = {
  known: [
    'opus',
    'sonnet',
    'haiku',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ],
  // Claude Code supports custom/gateway model ids such as DeepSeek via an
  // Anthropic-compatible endpoint, so preserve an explicit provider/model.
  idMap: { defaultProvider: 'anthropic', allowExplicitProvider: true, wireProviderQualified: true },
};
