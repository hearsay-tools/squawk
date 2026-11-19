import { defineRunner } from '../../core/runner-definition.ts';
import { CODEX_FACTS } from './facts.ts';
import { CODEX_MODELS } from './models.ts';
import { CODEX_CONFIG_FILES } from './config-files.ts';
import { CODEX_EXTRA_TOOLS } from './extra-tools.ts';
import { CODEX_SPEC_SUPPORT } from './spec-support.ts';

/** The Codex runner. */
export const codexRunner = defineRunner({
  id: 'codex',
  facts: CODEX_FACTS,
  specSupport: CODEX_SPEC_SUPPORT,
  loadAdapter: async () => new (await import('../../core/codex-app-server-runner.ts')).CodexAppServerRunner(),
  models: {
    ...CODEX_MODELS,
    loadSettings: async () => (await import('../../agent-config/model-settings/codex.ts')).codexModelSettingsStrategy,
  },
  loadModelCatalog: async () => (await import('../../core/codex-model-catalog.ts')).discoverCodexModels,
  loadSkillCatalog: async () => (await import('../../core/codex-skill-catalog.ts')).discoverCodexSkills,
  configFiles: CODEX_CONFIG_FILES,
  extraTools: CODEX_EXTRA_TOOLS,
});
