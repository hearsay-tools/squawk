import type { RunnerCli } from '../../core/runner-definition.ts';

/** How a terminal starts the Codex CLI and where the installer gets it. Data only: the definition and core read it. */
export const CODEX_CLI = {
  terminalExecutable: { kind: 'path-name', name: 'codex' },
  resumeArgs: id => `resume ${id}`,
  installSource: { npm: '@openai/codex' },
  openTarget: { label: 'Codex CLI', icon: 'codex' },
} as const satisfies RunnerCli;
