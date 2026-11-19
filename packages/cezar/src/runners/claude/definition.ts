import { defineRunner } from '../../core/runner-definition.ts';
import { productEnv } from '../../core/product-env.ts';
import { CLAUDE_FACTS } from './facts.ts';
import { CLAUDE_MODELS } from './models.ts';
import { CLAUDE_CONFIG_FILES } from './config-files.ts';
import { CLAUDE_EXTRA_TOOLS } from './extra-tools.ts';
import { CLAUDE_SPEC_SUPPORT } from './spec-support.ts';
import { CLAUDE_DETECTION } from './detection.ts';
import { CLAUDE_CLI } from './cli.ts';
import { CLAUDE_LOGIN } from './login.ts';
import { CLAUDE_ACCOUNTS } from './accounts.ts';
import { CLAUDE_ENV } from './env.ts';

/** The Claude runner. */
export const claudeRunner = defineRunner({
  id: 'claude',
  facts: CLAUDE_FACTS,
  specSupport: CLAUDE_SPEC_SUPPORT,
  detection: CLAUDE_DETECTION,
  cli: CLAUDE_CLI,
  loadAdapter: async () => new (await import('./claude-cli-runner.ts')).ClaudeCliRunner(),
  models: {
    ...CLAUDE_MODELS,
    loadSettings: async () => (await import('../../agent-config/model-settings/claude.ts')).claudeModelSettingsStrategy,
  },
  loadModelCatalog: async () => (await import('./claude-model-catalog.ts')).discoverClaudeModels,
  loadSkillCatalog: async () => (await import('./claude-skill-catalog.ts')).discoverClaudeSkills,
  configFiles: CLAUDE_CONFIG_FILES,
  extraTools: CLAUDE_EXTRA_TOOLS,
  login: { ...CLAUDE_LOGIN, executable: () => productEnv('CLAUDE_BIN') ?? 'claude' },
  accounts: CLAUDE_ACCOUNTS,
  env: CLAUDE_ENV,
  loadLogin: async () => ({ parse: (await import('./login-probe.ts')).parseClaudeStatus }),
});
