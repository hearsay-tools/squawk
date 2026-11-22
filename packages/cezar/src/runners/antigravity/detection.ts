import { productEnv } from '../../core/product-env.ts';
import type { RunnerDetection } from '../../core/runner-definition.ts';
import { antigravityOnPath, isAntigravityCli, managedAntigravity } from './executable.ts';
export const ANTIGRAVITY_DETECTION = {
  binary: 'agy', binOverride: () => productEnv('ANTIGRAVITY_BIN'), dryRun: 'unless-bin-override',
  locate: () => managedAntigravity() ?? antigravityOnPath(),
  // The CLI prints a bare version; its --help names the CLI and the acp command.
  identify: isAntigravityCli,
  banner: { pattern: /^\d+\.\d+\.\d+$/, label: 'the Google Antigravity CLI' },
  availableHint: 'Uses GEMINI_API_KEY, GOOGLE_API_KEY, or the Google sign-in of the selected account.',
  missingHint: 'Install the Antigravity CLI from Settings > Accounts > Install CLI, or put agy on PATH.',
} as const satisfies RunnerDetection;
