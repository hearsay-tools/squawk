import type { RunnerModelData } from '../../core/runner-definition.ts';

/** The OpenCode runner's model data. Data only: importing it loads no adapter. */
export const OPENCODE_MODELS: RunnerModelData = {
  suggested: [
    { id: '', label: 'auto', desc: 'Use your OpenCode default model' },
  ],
  known: [],
  retired: [],
  // opencode selects across providers, so a bare model is ambiguous: reject it
  // loudly rather than let the server pick a default the user never asked for.
  idMap: {},
};
