import { productEnv, type RunnerDetection } from '@hearsay-tools/squawk/plugin';

/** How the host probe finds the OpenCode CLI. Data only: the definition reads it and core runs the probe. */
export const OPENCODE_DETECTION = {
  binary: 'opencode',
  binOverride: () => productEnv('OPENCODE_BIN'),
  // Dry-run stands the runner up on its bundled mock (hearsay-tools/cezarion#1042),
  // unless CEZ_OPENCODE_BIN overrides it there as well.
  dryRun: 'unless-bin-override',
  availableHint: 'if no provider is configured, run `opencode` once to set one up',
  missingHint: 'optional: install OpenCode (https://opencode.ai) and configure a provider to use the OpenCode runner',
} as const satisfies RunnerDetection;
