import { productEnv, type RunnerDetection } from '@hearsay-tools/squawk/plugin';

/** How the host probe finds the Codex CLI. Data only: the definition reads it and core runs the probe. */
export const CODEX_DETECTION = {
  binary: 'codex',
  binOverride: () => productEnv('CODEX_BIN'),
  // Dry-run stands the runner up on its bundled mock, so report it present without
  // spawning the real CLI: `opencode --version` alone cost ~1-3 s per dry-run boot
  // under load (hearsay-tools/cezarion#1042). An explicit CEZ_CODEX_BIN outranks the
  // mock in the runner too, so it is still probed.
  dryRun: 'unless-bin-override',
  availableHint: 'if not authenticated, run `codex` once and log in',
  missingHint: 'optional: install the Codex CLI (npm i -g @openai/codex) and log in to use the Codex runner',
} as const satisfies RunnerDetection;
