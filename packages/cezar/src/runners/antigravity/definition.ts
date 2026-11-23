import { join } from 'node:path';
import { defineRunner } from '../../core/runner-definition.ts';
import { productEnv } from '../../core/product-env.ts';
import { antigravityStatusExecutable } from './executable.ts';
import { ANTIGRAVITY_FACTS } from './facts.ts';
import { ANTIGRAVITY_SPEC_SUPPORT } from './spec-support.ts';
import { ANTIGRAVITY_DETECTION } from './detection.ts';
import { ANTIGRAVITY_CLI } from './cli.ts';
import { ANTIGRAVITY_MODELS } from './models.ts';
import { ANTIGRAVITY_ACCOUNTS } from './accounts.ts';
import { ANTIGRAVITY_ENV } from './env.ts';
import { ANTIGRAVITY_MOCK } from './mock.ts';
import { ANTIGRAVITY_DISPLAY } from './display.ts';
import { ANTIGRAVITY_LOGIN } from './login.ts';
import { ANTIGRAVITY_EXTRA_TOOLS } from './extra-tools.ts';
import { ANTIGRAVITY_CONFIG_FILES } from './config-files.ts';
export const antigravityRunner = defineRunner({
  id: 'antigravity', facts: ANTIGRAVITY_FACTS, specSupport: ANTIGRAVITY_SPEC_SUPPORT,
  detection: ANTIGRAVITY_DETECTION, cli: ANTIGRAVITY_CLI,
  models: { ...ANTIGRAVITY_MODELS, loadSettings: async () => (await import('./model-settings.ts')).antigravityModelSettings },
  accounts: { ...ANTIGRAVITY_ACCOUNTS, homeDir: (env, home) => env.GEMINI_HOME?.trim() || join(home, '.gemini') },
  env: ANTIGRAVITY_ENV, mock: ANTIGRAVITY_MOCK, display: ANTIGRAVITY_DISPLAY,
  login: { ...ANTIGRAVITY_LOGIN, executable: () => productEnv('ANTIGRAVITY_BIN') || antigravityStatusExecutable() },
  configFiles: ANTIGRAVITY_CONFIG_FILES, extraTools: ANTIGRAVITY_EXTRA_TOOLS,
  loadLogin: async () => (await import('./login-probe.ts')).antigravityLogin,
  loadBrowserSignIn: async () => (await import('./browser-sign-in.ts')).startAntigravitySignIn,
  loadAdapter: async () => new (await import('./antigravity-runner.ts')).AntigravityRunner(),
  loadModelCatalog: async () => (await import('./antigravity-model-catalog.ts')).discoverAntigravityModels,
  loadModelCatalogKey: async () => (await import('./antigravity-model-catalog.ts')).antigravityModelCatalogKey,
  loadSkillCatalog: async () => (await import('./antigravity-skill-catalog.ts')).discoverAntigravitySkills,
});
