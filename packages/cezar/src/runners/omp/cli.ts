import { productEnv } from '../../core/product-env.ts';
import type { RunnerCli } from '../../core/runner-definition.ts';

/** How a terminal starts the OMP CLI and where the installer gets it. Data only: the definition and core read it. */
export const OMP_CLI = {
  terminalExecutable: { kind: 'configured', resolve: () => productEnv('OMP_BIN') ?? 'omp' },
  resumeArgs: id => `--resume ${id}`,
  installSource: null,
} as const satisfies RunnerCli;
