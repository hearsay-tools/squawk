import { productEnv } from '../../core/product-env.ts';
import type { RunnerDetection } from '../../core/runner-definition.ts';

/** How the host probe finds the pi CLI. Data only: the definition reads it and core runs the probe. */
export const PI_DETECTION = {
  binary: 'pi',
  binOverride: () => productEnv('PI_BIN'),
  // Dry-run stands the runner up on the shared mock, so report it present.
  dryRun: 'always',
  availableHint: 'if not authenticated, run `pi` once and log in',
  // A missing `pi` CLI is never a boot failure — the runner just isn't
  // offered, exactly like an absent codex/opencode.
  missingHint: 'optional: install the pi CLI and log in to use the pi runner',
} as const satisfies RunnerDetection;
