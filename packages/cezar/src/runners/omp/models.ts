import type { RunnerModelData } from '../../core/runner-definition.ts';

/** The OMP runner's model data. Data only: importing it loads no adapter. */
export const OMP_MODELS: RunnerModelData = {
  // omp lists nothing for pi's reason: `provider/model` ids with no default provider, so the
  // structural check in `modelConflictsWithRunner` guards it without vendor knowledge.
  known: [],
  // OMP is pi's fork: `provider/model`, no default provider, so a bare model is rejected loudly.
  idMap: {},
};
