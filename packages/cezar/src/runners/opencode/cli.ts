import type { RunnerCli } from '../../core/runner-definition.ts';

/** How a terminal starts the OpenCode CLI and where the installer gets it. Data only: the definition and core read it. */
export const OPENCODE_CLI = {
  terminalExecutable: { kind: 'path-name', name: 'opencode' },
  resumeArgs: id => `--session ${id}`,
  installSource: { site: 'https://opencode.ai', label: 'OpenCode' },
} as const satisfies RunnerCli;
