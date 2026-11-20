import { defineRunner } from '../../core/runner-definition.ts';
import { productEnv } from '../../core/product-env.ts';
import { CLAUDE_FACTS } from './facts.ts';
import { CLAUDE_MODELS } from './models.ts';
import { CLAUDE_AGENT_CONFIG, CLAUDE_CONFIG_FILES } from './config-files.ts';
import { CLAUDE_EXTRA_TOOLS } from './extra-tools.ts';
import { CLAUDE_SPEC_SUPPORT } from './spec-support.ts';
import { CLAUDE_DETECTION } from './detection.ts';
import { CLAUDE_CLI } from './cli.ts';
import { CLAUDE_LOGIN } from './login.ts';
import { CLAUDE_ACCOUNTS } from './accounts.ts';
import { CLAUDE_ENV } from './env.ts';
import { CLAUDE_MOCK } from './mock.ts';
import { CLAUDE_DISPLAY } from './display.ts';

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
  configFiles: { files: CLAUDE_CONFIG_FILES, agentConfig: CLAUDE_AGENT_CONFIG },
  extraTools: CLAUDE_EXTRA_TOOLS,
  login: { ...CLAUDE_LOGIN, executable: () => productEnv('CLAUDE_BIN') ?? 'claude' },
  accounts: CLAUDE_ACCOUNTS,
  env: CLAUDE_ENV,
  mock: CLAUDE_MOCK,
  loadLogin: async () => ({ parse: (await import('./login-probe.ts')).parseClaudeStatus }),
  display: CLAUDE_DISPLAY,
});
