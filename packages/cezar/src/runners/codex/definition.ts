import { join } from 'node:path';
import { defineRunner } from '../../core/runner-definition.ts';
import { productEnv } from '../../core/product-env.ts';
import { CODEX_FACTS } from './facts.ts';
import { CODEX_MODELS } from './models.ts';
import { CODEX_AGENT_CONFIG, CODEX_CONFIG_FILES } from './config-files.ts';
import { CODEX_EXTRA_TOOLS } from './extra-tools.ts';
import { CODEX_SPEC_SUPPORT } from './spec-support.ts';
import { CODEX_DETECTION } from './detection.ts';
import { CODEX_CLI } from './cli.ts';
import { CODEX_LOGIN } from './login.ts';
import { CODEX_ACCOUNTS } from './accounts.ts';
import { CODEX_ENV } from './env.ts';
import { CODEX_MOCK } from './mock.ts';
import { CODEX_DISPLAY } from './display.ts';

/** The Codex runner. */
export const codexRunner = defineRunner({
  id: 'codex',
  facts: CODEX_FACTS,
  specSupport: CODEX_SPEC_SUPPORT,
  detection: CODEX_DETECTION,
  cli: CODEX_CLI,
  loadAdapter: async () => new (await import('./codex-app-server-runner.ts')).CodexAppServerRunner(),
  models: {
    ...CODEX_MODELS,
    loadSettings: async () => (await import('../../agent-config/model-settings/codex.ts')).codexModelSettingsStrategy,
  },
  loadModelCatalog: async () => (await import('./codex-model-catalog.ts')).discoverCodexModels,
  loadSkillCatalog: async () => (await import('./codex-skill-catalog.ts')).discoverCodexSkills,
  configFiles: { files: CODEX_CONFIG_FILES, agentConfig: CODEX_AGENT_CONFIG },
  extraTools: CODEX_EXTRA_TOOLS,
  login: { ...CODEX_LOGIN, executable: () => productEnv('CODEX_BIN') ?? 'codex' },
  accounts: {
    ...CODEX_ACCOUNTS,
    // `$CODEX_HOME` relocates Codex's home; a blank value is ignored.
    resolveHome: (env, home) => env.CODEX_HOME?.trim() || join(home, '.codex'),
  },
  env: CODEX_ENV,
  mock: CODEX_MOCK,
  loadLogin: async () => ({ parse: (await import('./login-probe.ts')).parseCodexStatus }),
  display: CODEX_DISPLAY,
});
