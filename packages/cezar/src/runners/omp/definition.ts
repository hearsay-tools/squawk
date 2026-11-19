import { defineRunner } from '../../core/runner-definition.ts';
import { OMP_FACTS } from './facts.ts';
import { OMP_MODELS } from './models.ts';
import { OMP_CONFIG_FILES } from './config-files.ts';
import { OMP_EXTRA_TOOLS } from './extra-tools.ts';
import { OMP_SPEC_SUPPORT } from './spec-support.ts';
import { OMP_DETECTION } from './detection.ts';
import { OMP_CLI } from './cli.ts';

/** The OMP runner. */
export const ompRunner = defineRunner({
  id: 'omp',
  facts: OMP_FACTS,
  specSupport: OMP_SPEC_SUPPORT,
  detection: OMP_DETECTION,
  cli: OMP_CLI,
  loadAdapter: async () => new (await import('../../core/omp-runner.ts')).OmpRunner(),
  models: {
    ...OMP_MODELS,
    // OMP's native default model (its model roles) is not read: no native-default strategy, by the
    // spec's scope (§ Model selection). Returning nothing leaves the prompt unpinned, so OMP's own
    // model roles apply.
    loadSettings: async () => ({ runner: 'omp', async read() { return {}; } }),
  },
  loadModelCatalog: async () => (await import('../../core/omp-model-catalog.ts')).discoverOmpModels,
  loadSkillCatalog: async () => (await import('../../core/omp-skill-catalog.ts')).discoverOmpSkills,
  configFiles: OMP_CONFIG_FILES,
  extraTools: OMP_EXTRA_TOOLS,
});
