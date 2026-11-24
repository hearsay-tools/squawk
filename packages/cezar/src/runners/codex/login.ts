import type { RunnerLoginData } from '@hearsay-tools/squawk/plugin';

/** Codex's login and auth-status data (the `login` part). Data only: the definition and
 *  `ProviderAuthService` read this value, so importing it loads no code. */
export const CODEX_LOGIN = {
  statusArgs: ['login', 'status'],
  loginArgs: ['login'],
  installHint: 'Install the Codex CLI, then run `codex login`.',
} as const satisfies RunnerLoginData;
