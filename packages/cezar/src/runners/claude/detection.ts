import { productEnv } from '../../core/product-env.ts';
import type { RunnerDetection } from '../../core/runner-definition.ts';

/** How the host probe finds the Claude CLI. Data only: the definition reads it and core runs the probe. */
export const CLAUDE_DETECTION = {
  binary: 'claude',
  // `CEZ_CLAUDE_BIN` like every other claude call site (the runner, provider-auth,
  // open-in-app). Probing a bare `claude` reported "not installed" for a host whose
  // only install is at a custom path — which drops claude from the composer and the
  // installer's dependency step even though runs would have worked fine.
  binOverride: () => productEnv('CLAUDE_BIN'),
  dryRun: 'always',
  // A generic `claude` binary (a shell wrapper, an unrelated tool) can shadow
  // the real CLI on $PATH — reject anything that doesn't match the banner.
  banner: { pattern: /^\d+\.\d+|^claude(\s+code)?\s+version\s+\d+\.\d+/i, label: 'Claude Code' },
  availableHint: 'if not authenticated, run `claude` once and log in',
  missingHint: 'install Claude Code (npm i -g @anthropic-ai/claude-code) and log in',
} as const satisfies RunnerDetection;
