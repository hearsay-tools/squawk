import { join } from 'node:path';
import { agentHome, type AgentHomePaths, type RunnerConfigFile, EDITOR_PLUS_COMMIT_NOTE, PROJECT_AGENTS_FILE } from '@hearsay-tools/squawk/plugin';
import type { RunnerAgentConfig } from '@hearsay-tools/squawk/plugin';
import { CODEX_ACCOUNTS } from './accounts.ts';

const codexHome = (home: AgentHomePaths): string => agentHome(home, CODEX_ACCOUNTS.homeSlot);

const CODEX_CONFIG_DOCS = 'https://developers.openai.com/codex/config-reference';
const CODEX_AGENTS_DOCS = 'https://developers.openai.com/codex/guides/agents-md';

/**
 * The Codex runner's native config files for Settings → Agent config. Data only: importing it
 * loads no adapter. Order is presentation order: user → project → local, so the scope ladder
 * reads top (broad) to bottom (specific).
 */
export const CODEX_CONFIG_FILES: readonly RunnerConfigFile[] = [
  // ---- Codex ----
  {
    id: 'codex.user.config',
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(codexHome(home), 'config.toml'),
    label: '~/.codex/config.toml',
    format: 'toml',
    tracked: 'outside-repo',
    holdsMcp: true,
    modelKey: 'model',
    modelProviderKey: 'model_provider',
    modelPriority: 1,
    precedence:
      'User-level defaults. A trusted project’s .codex/config.toml overrides these; some keys (provider, auth, telemetry) cannot be overridden at project scope. MCP servers live here under [mcp_servers.<id>].',
    docsUrl: CODEX_CONFIG_DOCS,
  },
  {
    id: 'codex.project.config',
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, '.codex', 'config.toml'),
    label: '.codex/config.toml',
    format: 'toml',
    tracked: 'tracked',
    modelKey: 'model',
    modelPriority: 2,
    holdsMcp: true,
    precedence:
      'Applies only in projects you have trusted. Some keys (provider, auth, telemetry) cannot be overridden here. MCP servers go under [mcp_servers.<id>]. Runs read the committed copy.',
    docsUrl: CODEX_CONFIG_DOCS,
  },
  {
    id: 'codex.user.memory',
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(codexHome(home), 'AGENTS.md'),
    label: '~/.codex/AGENTS.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence:
      'Global instructions, read first (an AGENTS.override.md beside it wins if present). Project AGENTS.md files are concatenated after and override it.',
    docsUrl: CODEX_AGENTS_DOCS,
  },

  // <repo>/AGENTS.md, shared with Codex, OpenCode, Pi and OMP: the catalog lists it once.
  PROJECT_AGENTS_FILE,
];

/** The Codex tab of Settings → Agent config (the `agentConfig` of its `configFiles` part). Data only. */
export const CODEX_AGENT_CONFIG: RunnerAgentConfig = {
  label: 'Codex',
  note: EDITOR_PLUS_COMMIT_NOTE,
  groups: [
    { id: 'settings', label: 'Settings' },
    {
      id: 'mcp',
      label: 'MCP',
      note: 'Inside config.toml under [mcp_servers.<id>] — the same file as Codex’s settings.',
    },
    { id: 'memory', label: 'Memory & instructions' },
  ],
};
