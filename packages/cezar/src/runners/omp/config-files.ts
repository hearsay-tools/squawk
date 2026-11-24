import { join } from 'node:path';
import { agentHome, type AgentHomePaths, type RunnerConfigFile } from '../../core/runner-config-files.ts';
import type { RunnerAgentConfig } from '@open-mercato/cezar-contract/runners';
import { EDITOR_PLUS_COMMIT_NOTE } from '../../core/agent-config-notes.ts';
import { PROJECT_AGENTS_FILE } from '../../core/project-agents-file.ts';
import { OMP_ACCOUNTS } from './accounts.ts';

const ompHome = (home: AgentHomePaths): string => agentHome(home, OMP_ACCOUNTS.homeSlot);

const OMP_CONFIG_DOCS = 'https://github.com/can1357/oh-my-pi/blob/main/docs/config-usage.md';
const OMP_MCP_DOCS = 'https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md';

/**
 * The OMP runner's native config files for Settings → Agent config. Data only: importing it
 * loads no adapter. Order is presentation order: user → project → local, so the scope ladder
 * reads top (broad) to bottom (specific).
 */
export const OMP_CONFIG_FILES: readonly RunnerConfigFile[] = [
  // ---- OMP: verified 2026-10-02 against v18.4.11 ----
  // Oh My Pi (`can1357/oh-my-pi`, docs at main @ 7318a70cf4ed). The user layer lives in
  // `AgentHomePaths.omp` (`$PI_CODING_AGENT_DIR` or `~/${PI_CONFIG_DIR || '.omp'}/agent`, the default
  // profile; a named profile relocates it and is not modelled). Project files always live in
  // `<repo>/.omp/`. Settings are YAML (`config.yml`); no `modelKey`, because OMP has no native-default
  // strategy Squawk reads (spec § Model selection). Precedence strings quote the docs in doc order;
  // a numbered doc list is joined with "; ", its wording untouched. Not listed, by the spec's
  // scope: `.omp/AGENTS.md` (OMP's native project context file; project memory is the shared root
  // `AGENTS.md` row) and the `.omp/.mcp.json` / user `.mcp.json` compatibility spellings.
  {
    id: 'omp.user.settings',
    kind: 'settings',
    scope: 'user',
    resolve: (_repo, home) => join(ompHome(home), 'config.yml'),
    label: '~/.omp/agent/config.yml',
    format: 'yaml',
    tracked: 'outside-repo',
    precedence:
      // config-usage.md § Layers, the six-tier list.
      'Effective precedence, highest first: 1. Environment variable declared on the definition (`env: "NAME"`), parsed by the setting\'s type; unparseable text counts as unset. Booleans follow `parseFlag`: empty is unset, `1`/`y`/`true`/`yes`/`on` (lower or upper case) is true, any other text is false; 2. Runtime overrides: in-memory, non-persistent; 3. Config overlays: `PI_CONFIG_FILES` (platform path-list), followed by repeated `omp --config <path>` files; all are loaded as `config.yml`-style YAML for this process only; 4. Project settings: discovered via the settings capability (`settings.json` and `config.yml` from providers); 5. Global settings: the first present file among `~/.omp/agent/config.yml` and `config.yaml`; 6. Definition default',
    docsUrl: OMP_CONFIG_DOCS,
  },
  {
    id: 'omp.project.settings',
    kind: 'settings',
    scope: 'project',
    resolve: (repo) => join(repo, '.omp', 'config.yml'),
    label: '.omp/config.yml',
    format: 'yaml',
    tracked: 'tracked',
    precedence:
      'Project settings: discovered via the settings capability (`settings.json` and `config.yml` from providers). Within the native provider, project `config.yml` follows and overrides `settings.json`. Runs read the committed copy.',
    docsUrl: OMP_CONFIG_DOCS,
  },
  {
    id: 'omp.user.mcp',
    kind: 'mcp',
    scope: 'user',
    resolve: (_repo, home) => join(ompHome(home), 'mcp.json'),
    label: '~/.omp/agent/mcp.json',
    format: 'json',
    tracked: 'outside-repo',
    holdsMcp: true,
    precedence:
      'Across providers, the first definition wins. Duplicate names are not merged; OpenCode\'s internal config layers are the exception described above. Within OMP native config, project `.omp/mcp.json` precedes `.omp/.mcp.json`, then the active profile\'s user `mcp.json` and `.mcp.json`.',
    docsUrl: OMP_MCP_DOCS,
  },
  {
    id: 'omp.project.mcp',
    kind: 'mcp',
    scope: 'project',
    resolve: (repo) => join(repo, '.omp', 'mcp.json'),
    label: '.omp/mcp.json',
    format: 'json',
    tracked: 'tracked',
    holdsMcp: true,
    precedence:
      'Across providers, the first definition wins. Duplicate names are not merged; OpenCode\'s internal config layers are the exception described above. Within OMP native config, project `.omp/mcp.json` precedes `.omp/.mcp.json`, then the active profile\'s user `mcp.json` and `.mcp.json`. Runs read the committed copy.',
    docsUrl: OMP_MCP_DOCS,
  },
  {
    id: 'omp.user.memory',
    kind: 'memory',
    scope: 'user',
    resolve: (_repo, home) => join(ompHome(home), 'AGENTS.md'),
    label: '~/.omp/agent/AGENTS.md',
    format: 'markdown',
    tracked: 'outside-repo',
    precedence:
      '`SYSTEM.md`, `SYSTEM_TEMPLATE.md`, `RULES.md`, and `.omp/AGENTS.md` read user-level files directly and use the nearest non-empty ancestor `.omp` directory for project files. Context files: `.omp/AGENTS.md`; standalone ancestor `AGENTS.md` files are loaded separately by the low-priority `agents-md` provider',
    docsUrl: OMP_CONFIG_DOCS,
  },

  // <repo>/AGENTS.md, shared with Codex, OpenCode, Pi and OMP: the catalog lists it once.
  PROJECT_AGENTS_FILE,
];

/** The OMP tab of Settings → Agent config (the `agentConfig` of its `configFiles` part). Data only. */
export const OMP_AGENT_CONFIG: RunnerAgentConfig = {
  label: 'OMP',
  note: EDITOR_PLUS_COMMIT_NOTE,
  groups: [
    { id: 'settings', label: 'Settings' },
    {
      id: 'mcp',
      label: 'MCP',
      note: 'A dedicated mcp.json (key: mcpServers) at ~/.omp/agent and in the project’s .omp/ folder.',
    },
    { id: 'memory', label: 'Memory & instructions' },
  ],
};
