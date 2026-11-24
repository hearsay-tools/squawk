import type { RunnerCli } from '@hearsay-tools/squawk/plugin';

/** How a terminal starts the pi CLI and where the installer gets it. Data only: the definition and core read it. */
export const PI_CLI = {
  terminalExecutable: { kind: 'path-name', name: 'pi' },
  resumeArgs: id => `--session ${id}`,
  installSource: null,
  openTarget: { label: 'pi CLI', icon: 'pi' },
} as const satisfies RunnerCli;
