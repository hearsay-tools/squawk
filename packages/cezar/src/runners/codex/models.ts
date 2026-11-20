import type { RunnerModelData } from '../../core/runner-definition.ts';

/** The Codex runner's model data. Data only: importing it loads no adapter. */
export const CODEX_MODELS: RunnerModelData = {
  suggested: [{ id: '', label: 'auto', desc: 'Use your Codex default model' }],
  retired: [],
  known: ['gpt-5.1-codex', 'gpt-5.1-codex-mini', 'gpt-5-codex'],
  // Codex selects the provider from model_provider in config.toml. A foreign
  // explicit prefix is accepted only when the caller proves it matches that
  // effective setting; the provider is then stripped from the wire model id.
  idMap: { defaultProvider: 'openai' },
};
