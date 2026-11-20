import { join } from 'node:path';
import { agentHome, type AgentHomePaths, type ConfigFileDef } from '../../core/runner-config-files.ts';
import type { RunnerAgentConfig } from '@open-mercato/cezar-contract/runners';
import { EDITOR_PLUS_COMMIT_NOTE } from '../agent-config-notes.ts';
import { PROJECT_AGENTS_FILE } from '../project-agents-file.ts';
import { PI_ACCOUNTS } from './accounts.ts';

const piHome = (home: AgentHomePaths): string => agentHome(home, PI_ACCOUNTS.homeSlot);

const PI_SETTINGS_DOCS = 'https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md';
const PI_CONTEXT_FILES_DOCS = 'https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md#context-files';

/**
 * The pi runner's native config files for Settings → Agent config. Data only: importing it
 * loads no adapter. Order is presentation order: user → project → local, so the scope ladder
 * reads top (broad) to bottom (specific).
 */
export const PI_CONFIG_FILES: readonly ConfigFileDef[] = [
  // ---- Pi ----
  // Pi has no MCP file of its own: its README says "No MCP." — servers arrive only through a Pi
  // extension, so nothing here carries `holdsMcp` and the cockpit's MCP group states that instead.
  {
    id: 'pi.user.settings',
    runners: ['pi'],
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(piHome(home), 'settings.json'),
    label: '~/.pi/agent/settings.json',
    format: 'json',
    tracked: 'outside-repo',
    modelKey: 'defaultModel',
    modelProviderKey: 'defaultProvider',
    modelPriority: 1,
    precedence:
      'Global (all projects). Project settings override global settings — the two merge recursively, so nested objects combine rather than replace. Startup model: defaultProvider + defaultModel.',
    docsUrl: PI_SETTINGS_DOCS,
  },
  {
    id: 'pi.project.settings',
    runners: ['pi'],
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, '.pi', 'settings.json'),
    label: '.pi/settings.json',
    format: 'json',
    tracked: 'tracked',
    modelKey: 'defaultModel',
    modelProviderKey: 'defaultProvider',
    modelPriority: 2,
    precedence:
      `Overrides global settings (merged recursively). Loaded only once the project folder is trusted; non-interactive modes such as --mode rpc fall back to defaultProjectTrust in the global settings and ignore it under "ask" or "never" — Squawk reads a native default model from it only when that value is "always". Runs read the committed copy.`,
    docsUrl: PI_SETTINGS_DOCS,
  },
  {
    id: 'pi.user.memory',
    runners: ['pi'],
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(piHome(home), 'AGENTS.md'),
    label: '~/.pi/agent/AGENTS.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence:
      'Global context file, loaded first. Every AGENTS.md (or CLAUDE.md) from the parent directories down to the current one is concatenated after it; an AGENTS.override.md replaces that directory’s file only.',
    docsUrl: PI_CONTEXT_FILES_DOCS,
  },

  // <repo>/AGENTS.md, shared with Codex, OpenCode, Pi and OMP: the catalog lists it once.
  PROJECT_AGENTS_FILE,
];

/** The Pi tab of Settings → Agent config (the `agentConfig` of its `configFiles` part). Data only. */
export const PI_AGENT_CONFIG: RunnerAgentConfig = {
  label: 'Pi',
  note: EDITOR_PLUS_COMMIT_NOTE,
  groups: [
    { id: 'settings', label: 'Settings' },
    {
      id: 'mcp',
      label: 'MCP',
      note: 'Pi ships no MCP client, so it has no MCP file to edit.',
      empty: 'Nothing to list: Pi’s README says "No MCP." Give Pi tools as CLI programs with a README (Pi skills), or install a Pi extension that adds MCP support and configure servers there.',
    },
    { id: 'memory', label: 'Memory & instructions' },
  ],
};
