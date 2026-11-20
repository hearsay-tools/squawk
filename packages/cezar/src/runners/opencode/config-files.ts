import { join } from 'node:path';
import { agentHome, type AgentHomePaths, type ConfigFileDef } from '../../core/runner-config-files.ts';
import type { RunnerAgentConfig } from '@open-mercato/cezar-contract/runners';
import { EDITOR_PLUS_COMMIT_NOTE } from '../agent-config-notes.ts';
import { PROJECT_AGENTS_FILE } from '../project-agents-file.ts';
import { OPENCODE_ACCOUNTS } from './accounts.ts';

const opencodeHome = (home: AgentHomePaths): string => agentHome(home, OPENCODE_ACCOUNTS.homeSlot);

const OPENCODE_CONFIG_DOCS = 'https://opencode.ai/docs/config/';
const OPENCODE_RULES_DOCS = 'https://opencode.ai/docs/rules/';

/**
 * The OpenCode runner's native config files for Settings → Agent config. Data only: importing it
 * loads no adapter. Order is presentation order: user → project → local, so the scope ladder
 * reads top (broad) to bottom (specific).
 */
export const OPENCODE_CONFIG_FILES: readonly ConfigFileDef[] = [
  // ---- OpenCode ----
  {
    id: 'opencode.user.config',
    runners: ['opencode'],
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(opencodeHome(home), 'opencode.json'),
    label: '~/.config/opencode/opencode.json',
    format: 'jsonc',
    tracked: 'outside-repo',
    holdsMcp: true,
    modelKey: 'model',
    modelPriority: 1,
    precedence:
      'Global config. Merged with the project config, not replaced — later configs override earlier ones only for conflicting keys. MCP servers live under the "mcp" key.',
    docsUrl: OPENCODE_CONFIG_DOCS,
  },
  {
    id: 'opencode.project.config',
    runners: ['opencode'],
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, 'opencode.json'),
    label: 'opencode.json',
    format: 'jsonc',
    tracked: 'tracked',
    holdsMcp: true,
    modelKey: 'model',
    modelPriority: 2,
    precedence:
      'Merged over the global config per conflicting key (not a wholesale replace). MCP servers live under the "mcp" key. Runs read the committed copy.',
    docsUrl: OPENCODE_CONFIG_DOCS,
  },
  {
    id: 'opencode.user.memory',
    runners: ['opencode'],
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(opencodeHome(home), 'AGENTS.md'),
    label: '~/.config/opencode/AGENTS.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence:
      'Global rules. First match wins across scopes: if a project AGENTS.md exists, this global file is not read at all.',
    docsUrl: OPENCODE_RULES_DOCS,
  },

  // <repo>/AGENTS.md, shared with Codex, OpenCode, Pi and OMP: the catalog lists it once.
  PROJECT_AGENTS_FILE,
];

/** The OpenCode tab of Settings → Agent config (the `agentConfig` of its `configFiles` part). Data only. */
export const OPENCODE_AGENT_CONFIG: RunnerAgentConfig = {
  label: 'OpenCode',
  note: EDITOR_PLUS_COMMIT_NOTE,
  groups: [
    { id: 'settings', label: 'Settings' },
    {
      id: 'mcp',
      label: 'MCP',
      note: 'Under the "mcp" key in opencode.json — the same file as OpenCode’s settings.',
    },
    { id: 'memory', label: 'Memory & instructions' },
  ],
};
