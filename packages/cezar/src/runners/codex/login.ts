import type { RunnerLogin } from '../../core/runner-definition.ts';

/** Codex's login and auth-status data (the `login` part). Data only: the definition and
 *  `ProviderAuthService` read this value, so importing it loads no code. */
export const CODEX_LOGIN = {
  executable: { env: 'CODEX_BIN', fallback: 'codex' },
  statusArgs: ['login', 'status'],
  loginArgs: ['login'],
  installHint: 'Install the Codex CLI, then run `codex login`.',
} as const satisfies RunnerLogin;
