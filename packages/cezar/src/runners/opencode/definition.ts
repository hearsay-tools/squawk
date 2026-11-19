import { defineRunner } from '../../core/runner-definition.ts';
import { productEnv } from '../../core/product-env.ts';
import { OPENCODE_FACTS } from './facts.ts';
import { OPENCODE_MODELS } from './models.ts';
import { OPENCODE_CONFIG_FILES } from './config-files.ts';
import { OPENCODE_EXTRA_TOOLS } from './extra-tools.ts';
import { OPENCODE_SPEC_SUPPORT } from './spec-support.ts';
import { OPENCODE_DETECTION } from './detection.ts';
import { OPENCODE_CLI } from './cli.ts';
import { OPENCODE_LOGIN } from './login.ts';
import { OPENCODE_ACCOUNTS } from './accounts.ts';
import { OPENCODE_ENV } from './env.ts';

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
  login: { ...OPENCODE_LOGIN, executable: () => productEnv('OPENCODE_BIN') ?? 'opencode' },
  accounts: OPENCODE_ACCOUNTS,
  env: OPENCODE_ENV,
  loadLogin: async () => ({ parse: (await import('./login-probe.ts')).parseOpenCodeStatus }),
});
