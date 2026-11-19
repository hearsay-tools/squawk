import { defineRunner } from '../../core/runner-definition.ts';
import { CODEX_FACTS } from './facts.ts';
import { CODEX_MODELS } from './models.ts';

/** The Codex runner. */
export const codexRunner = defineRunner({
  id: 'codex',
  facts: CODEX_FACTS,
  loadAdapter: async () => new (await import('../../core/codex-app-server-runner.ts')).CodexAppServerRunner(),
  models: {
    ...CODEX_MODELS,
    loadSettings: async () => (await import('../../agent-config/model-settings/codex.ts')).codexModelSettingsStrategy,
  },
  loadModelCatalog: async () => (await import('../../core/codex-model-catalog.ts')).discoverCodexModels,
  loadSkillCatalog: async () => (await import('../../core/codex-skill-catalog.ts')).discoverCodexSkills,
});
