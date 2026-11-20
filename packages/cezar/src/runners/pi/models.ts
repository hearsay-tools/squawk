import type { RunnerModelData } from '../../core/runner-definition.ts';

/** The pi runner's model data. Data only: importing it loads no adapter. */
export const PI_MODELS: RunnerModelData = {
  suggested: [{ id: '', label: 'auto', desc: 'Use your pi default model' }],
  retired: [],
  // pi lists nothing for the same reason OpenCode does (#794), plus one of its own: it picks a
  // model with the canonical `provider/model` convention and has no default provider, so the
  // structural check in `modelConflictsWithRunner` already guards it without vendor
  // knowledge. Listing pi's composer presets here would actively break OpenCode — the ids
  // overlap (`anthropic/claude-sonnet-5`), and a shared id present in pi's list but absent from
  // OpenCode's empty one would read as "another runner's preset" and be refused.
  known: [],
  // pi selects across providers with the same `provider/model` convention as
  // opencode (#387) — no default provider, so a bare model is rejected loudly
  // and `toBackendModel` hands pi the full `provider/model` on its `--model`.
  idMap: {},
};
