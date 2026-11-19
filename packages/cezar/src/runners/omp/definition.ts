import { defineRunner } from '../../core/runner-definition.ts';
import { OMP_FACTS } from './facts.ts';
import { OMP_MODELS } from './models.ts';
import { OMP_CONFIG_FILES } from './config-files.ts';

/** The OMP runner. */
export const ompRunner = defineRunner({
  id: 'omp',
  facts: OMP_FACTS,
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
  // R1 (rulings): find and ast_grep are gated behind settings that default off, and a --tools
  // list naming an unavailable built-in exits 2, so they cannot be in the zero-config default.
  extraTools: ['todo', 'lsp', 'ast_edit', 'task', 'wait'],
});
