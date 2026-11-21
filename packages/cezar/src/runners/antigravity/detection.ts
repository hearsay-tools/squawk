import { productEnv } from '../../core/product-env.ts';
import type { RunnerDetection } from '../../core/runner-definition.ts';
export const ANTIGRAVITY_DETECTION = {
  binary: 'agy', binOverride: () => productEnv('ANTIGRAVITY_BIN'), dryRun: 'unless-bin-override',
  banner: { pattern: /antigravity_extensions\/acp_server/, label: 'Google Antigravity ACP server' },
  availableHint: 'Uses your Antigravity sign-in in ~/.gemini.',
  missingHint: 'Install the Antigravity ACP registry archive and link agy to agy_acp_server.par. Keep localharness_external beside the .par.',
} as const satisfies RunnerDetection;
