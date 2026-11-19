import { defineRunner } from '../../core/runner-definition.ts';
import { OPENCODE_FACTS } from './facts.ts';
import { OPENCODE_MODELS } from './models.ts';

/** The OpenCode runner. */
export const opencodeRunner = defineRunner({
  id: 'opencode',
  facts: OPENCODE_FACTS,
  loadAdapter: async () => new (await import('../../core/opencode-server-runner.ts')).OpencodeServerRunner(),
  models: {
    ...OPENCODE_MODELS,
    loadSettings: async () => (await import('../../agent-config/model-settings/opencode.ts')).opencodeModelSettingsStrategy,
  },
  loadModelCatalog: async () => (await import('../../core/opencode-model-catalog.ts')).discoverOpencodeModels,
  loadSkillCatalog: async () => (await import('../../core/opencode-skill-catalog.ts')).discoverOpencodeSkills,
});
