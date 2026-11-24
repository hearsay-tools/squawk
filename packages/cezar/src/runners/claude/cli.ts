import type { RunnerCli } from '@hearsay-tools/squawk/plugin';

/** How a terminal starts the Claude CLI and where the installer gets it. Data only: the definition and core read it. */
export const CLAUDE_CLI = {
  terminalExecutable: { kind: 'path-name', name: 'claude' },
  resumeArgs: id => `--resume ${id}`,
  installSource: { npm: '@anthropic-ai/claude-code' },
  openTarget: { label: 'Claude CLI', icon: 'claude' },
} as const satisfies RunnerCli;
