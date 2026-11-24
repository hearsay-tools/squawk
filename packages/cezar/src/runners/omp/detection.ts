import { productEnv, type RunnerDetection } from '@hearsay-tools/squawk/plugin';

/** How the host probe finds the OMP CLI. Data only: the definition reads it and core runs the probe. */
export const OMP_DETECTION = {
  binary: 'omp',
  binOverride: () => productEnv('OMP_BIN'),
  // Dry-run stands the runner up on the shared mock, so report it present.
  dryRun: 'always',
  availableHint: 'if not authenticated, run `omp login`',
  // A missing `omp` CLI is never a boot failure — the runner just isn't offered.
  missingHint: 'optional: install OMP (omp.sh) and run `omp login` to use the OMP runner',
} as const satisfies RunnerDetection;
