import type { RunnerConfigFiles } from '@hearsay-tools/squawk/plugin';
export const ANTIGRAVITY_CONFIG_FILES: RunnerConfigFiles = {
  files: [], agentConfig: { label: 'Antigravity', note: 'Uses your existing Antigravity setup.', groups: [
    { id: 'settings', label: 'Settings', empty: 'Uses your existing Antigravity setup.' },
    { id: 'mcp', label: 'MCP', note: 'Squawk supplies its tools through ACP.', empty: 'No MCP configuration files are exposed.' },
    { id: 'memory', label: 'Memory & instructions', empty: 'Squawk sends task instructions through ACP.' },
  ] },
};
