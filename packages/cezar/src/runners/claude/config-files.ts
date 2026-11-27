import { join } from 'node:path';
import { agentHome, type AgentHomePaths, type RunnerConfigFile } from '@hearsay-tools/squawk/plugin';
import type { RunnerAgentConfig } from '@hearsay-tools/squawk/plugin';
import { CLAUDE_ACCOUNTS } from './accounts.ts';

const claudeHome = (home: AgentHomePaths): string => agentHome(home, CLAUDE_ACCOUNTS.homeSlot);

const CLAUDE_SETTINGS_DOCS = 'https://code.claude.com/docs/en/settings';
const CLAUDE_MEMORY_DOCS = 'https://code.claude.com/docs/en/memory';
const CLAUDE_MCP_DOCS = 'https://code.claude.com/docs/en/mcp';

/**
 * The Claude runner's native config files for Settings → Agent config. Data only: importing it
 * loads no adapter. Order is presentation order: user → project → local, so the scope ladder
 * reads top (broad) to bottom (specific).
 */
export const CLAUDE_CONFIG_FILES: readonly RunnerConfigFile[] = [
  // ---- Claude Code ----
  {
    id: 'claude.user.settings',
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(claudeHome(home), 'settings.json'),
    label: '~/.claude/settings.json',
    format: 'json',
    tracked: 'outside-repo',
    modelKey: 'model',
    modelKeys: ['env.ANTHROPIC_MODEL', 'model'],
    modelPriority: 1,
    precedence:
      'Lowest priority. Project and local settings override it key by key — except permission rules, which merge across all scopes.',
    hotReload: 'Edits to most keys — including permissions and hooks — apply to a running session without a restart.',
    docsUrl: CLAUDE_SETTINGS_DOCS,
  },
  {
    id: 'claude.project.settings',
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, '.claude', 'settings.json'),
    label: '.claude/settings.json',
    format: 'json',
    tracked: 'tracked',
    modelKey: 'model',
    modelKeys: ['env.ANTHROPIC_MODEL', 'model'],
    modelPriority: 2,
    precedence:
      'Overrides user settings key by key (permission rules merge). Local settings override this.',
    hotReload: 'Edits to most keys — including permissions and hooks — apply to a running session without a restart.',
    docsUrl: CLAUDE_SETTINGS_DOCS,
  },
  {
    id: 'claude.local.settings',
    kind: 'settings',
    scope: 'local',
    resolve: (repo) => join(repo, '.claude', 'settings.local.json'),
    label: '.claude/settings.local.json',
    format: 'json',
    tracked: 'gitignored',
    seeded: true,
    modelKey: 'model',
    modelKeys: ['env.ANTHROPIC_MODEL', 'model'],
    modelPriority: 3,
    precedence:
      'Highest of the file scopes — overrides project and user (permission rules merge). Git-ignored; copied into each run’s worktree so it takes effect immediately.',
    hotReload: 'Edits to most keys — including permissions and hooks — apply to a running session without a restart.',
    docsUrl: CLAUDE_SETTINGS_DOCS,
  },
  {
    id: 'claude.project.mcp',
    kind: 'mcp',
    scope: 'project',
    resolve: (repo) => join(repo, '.mcp.json'),
    label: '.mcp.json',
    format: 'json',
    tracked: 'tracked',
    holdsMcp: true,
    precedence:
      `Project-scoped MCP servers (key: mcpServers), shared via version control. Each requires approval before use; user- and local-scoped servers live in ~/.claude.json, which Squawk does not edit.`,
    docsUrl: CLAUDE_MCP_DOCS,
  },
  {
    id: 'claude.user.memory',
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(claudeHome(home), 'CLAUDE.md'),
    label: '~/.claude/CLAUDE.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence: 'Not overridden — every CLAUDE.md that loads is concatenated, this user file first.',
    docsUrl: CLAUDE_MEMORY_DOCS,
  },
  {
    id: 'claude.project.memory',
    kind: 'memory',
    scope: 'project',
    resolve: (repo) => join(repo, 'CLAUDE.md'),
    label: 'CLAUDE.md',
    format: 'markdown',
    tracked: 'tracked',
    precedence:
      'Concatenated after the user file, not replacing it. Claude does not read AGENTS.md — import it here with @AGENTS.md. Runs read the committed copy.',
    docsUrl: CLAUDE_MEMORY_DOCS,
  },
  {
    id: 'claude.local.memory',
    kind: 'memory',
    scope: 'local',
    resolve: (repo) => join(repo, 'CLAUDE.local.md'),
    label: 'CLAUDE.local.md',
    format: 'markdown',
    tracked: 'gitignored',
    seeded: true,
    precedence:
      'Loads alongside CLAUDE.md, concatenated last. Git-ignored; copied into each run’s worktree so it takes effect immediately.',
    docsUrl: CLAUDE_MEMORY_DOCS,
  },
];

/** The Claude tab of Settings → Agent config (the `agentConfig` of its `configFiles` part). Data only. */
export const CLAUDE_AGENT_CONFIG: RunnerAgentConfig = {
  label: 'Claude Code',
  groups: [
    { id: 'settings', label: 'Settings' },
    {
      id: 'mcp',
      label: 'MCP',
      note: 'A dedicated .mcp.json (key: mcpServers), shared via version control.',
      showsUserMcp: true,
    },
    { id: 'memory', label: 'Memory & instructions' },
  ],
};
