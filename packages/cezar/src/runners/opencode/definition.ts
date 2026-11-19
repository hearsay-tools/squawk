import { defineRunner } from '../../core/runner-definition.ts';
import { OPENCODE_FACTS } from './facts.ts';
import { OPENCODE_MODELS } from './models.ts';
import { OPENCODE_CONFIG_FILES } from './config-files.ts';
import { OPENCODE_EXTRA_TOOLS } from './extra-tools.ts';
import { OPENCODE_SPEC_SUPPORT } from './spec-support.ts';
import { OPENCODE_DETECTION } from './detection.ts';
import { OPENCODE_CLI } from './cli.ts';

/** The OpenCode runner. */
export const opencodeRunner = defineRunner({
  id: 'opencode',
  facts: OPENCODE_FACTS,
  specSupport: OPENCODE_SPEC_SUPPORT,
  detection: OPENCODE_DETECTION,
  cli: OPENCODE_CLI,
  loadAdapter: async () => new (await import('../../core/opencode-server-runner.ts')).OpencodeServerRunner(),
  models: {
    ...OPENCODE_MODELS,
    loadSettings: async () => (await import('../../agent-config/model-settings/opencode.ts')).opencodeModelSettingsStrategy,
  },
  loadModelCatalog: async () => (await import('../../core/opencode-model-catalog.ts')).discoverOpencodeModels,
  loadSkillCatalog: async () => (await import('../../core/opencode-skill-catalog.ts')).discoverOpencodeSkills,
  configFiles: OPENCODE_CONFIG_FILES,
  extraTools: OPENCODE_EXTRA_TOOLS,
});
