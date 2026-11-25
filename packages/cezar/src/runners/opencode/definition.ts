import { join } from 'node:path';
import { defineRunner, productEnv } from '@hearsay-tools/squawk/plugin';
import { OPENCODE_FACTS } from './facts.ts';
import { OPENCODE_MODELS } from './models.ts';
import { OPENCODE_AGENT_CONFIG, OPENCODE_CONFIG_FILES } from './config-files.ts';
import { OPENCODE_EXTRA_TOOLS } from './extra-tools.ts';
import { OPENCODE_SPEC_SUPPORT } from './spec-support.ts';
import { OPENCODE_DETECTION } from './detection.ts';
import { OPENCODE_CLI } from './cli.ts';
import { OPENCODE_LOGIN } from './login.ts';
import { OPENCODE_ACCOUNTS } from './accounts.ts';
import { OPENCODE_ENV } from './env.ts';
import { OPENCODE_MOCK } from './mock.ts';
import { OPENCODE_DISPLAY } from './display.ts';

/** The OpenCode runner. */
export const opencodeRunner = defineRunner({
  id: 'opencode',
  facts: OPENCODE_FACTS,
  specSupport: OPENCODE_SPEC_SUPPORT,
  detection: OPENCODE_DETECTION,
  cli: OPENCODE_CLI,
  loadAdapter: async () => new (await import('./opencode-server-runner.ts')).OpencodeServerRunner(),
  models: {
    ...OPENCODE_MODELS,
    loadSettings: async () => (await import('./model-settings.ts')).opencodeModelSettingsStrategy,
  },
  loadModelCatalog: async () => (await import('./opencode-model-catalog.ts')).discoverOpencodeModels,
  loadSkillCatalog: async () => (await import('./opencode-skill-catalog.ts')).discoverOpencodeSkills,
  configFiles: { files: OPENCODE_CONFIG_FILES, agentConfig: OPENCODE_AGENT_CONFIG },
  extraTools: OPENCODE_EXTRA_TOOLS,
  login: { ...OPENCODE_LOGIN, executable: () => productEnv('OPENCODE_BIN') ?? 'opencode' },
  accounts: {
    ...OPENCODE_ACCOUNTS,
    // OpenCode's config dir sits under `$XDG_CONFIG_HOME`, else `~/.config`.
    homeDir: (env, home) => join(env.XDG_CONFIG_HOME?.trim() || join(home, '.config'), 'opencode'),
  },
  env: OPENCODE_ENV,
  mock: OPENCODE_MOCK,
  loadLogin: async () => ({ parse: (await import('./login-probe.ts')).parseOpenCodeStatus }),
  display: OPENCODE_DISPLAY,
});
