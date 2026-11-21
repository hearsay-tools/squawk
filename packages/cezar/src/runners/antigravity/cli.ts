import type { RunnerCli } from '../../core/runner-definition.ts';
export const ANTIGRAVITY_CLI = {
  interactive: false,
  terminalExecutable: { kind: 'path-name', name: 'agy' },
  // The server has no interactive terminal or session-resume command.
  resumeArgs: () => '',
  installSource: { site: 'https://antigravity.google', label: 'Antigravity ACP registry archive' },
  openTarget: { label: 'Antigravity ACP server', icon: 'bot' },
} as const satisfies RunnerCli;
