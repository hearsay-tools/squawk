import { productEnv, type RunnerCli } from '@hearsay-tools/squawk/plugin';

/** How a terminal starts the OMP CLI and where the installer gets it. Data only: the definition and core read it. */
export const OMP_CLI = {
  terminalExecutable: { kind: 'configured', resolve: () => productEnv('OMP_BIN') ?? 'omp' },
  resumeArgs: id => `--resume ${id}`,
  installSource: null,
  openTarget: { label: 'OMP CLI', icon: 'omp' },
} as const satisfies RunnerCli;
