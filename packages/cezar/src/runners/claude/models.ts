import type { RunnerModelData } from '../../core/runner-definition.ts';

/** The Claude runner's model data. Data only: importing it loads no adapter. */
export const CLAUDE_MODELS: RunnerModelData = {
  suggested: [
    { id: '', label: 'auto', desc: 'Pick the best model per step' },
    { id: 'opus', label: 'opus', desc: 'Deep reasoning for hard tasks' },
    { id: 'sonnet', label: 'sonnet', desc: 'Fast and cheap' },
    { id: 'haiku', label: 'haiku', desc: 'Fastest — simple, scoped tasks' },
  ],
  retired: ['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
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
