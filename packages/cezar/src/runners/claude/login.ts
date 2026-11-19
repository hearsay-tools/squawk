import type { RunnerLogin } from '../../core/runner-definition.ts';

/** Claude's login and auth-status data (the `login` part). Data only: the definition and
 *  `ProviderAuthService` read this value, so importing it loads no code. */
export const CLAUDE_LOGIN = {
  executable: { env: 'CLAUDE_BIN', fallback: 'claude' },
  statusArgs: ['auth', 'status', '--json'],
  loginArgs: ['auth', 'login'],
  installHint: 'Install Claude Code, then run `claude auth login`.',
} as const satisfies RunnerLogin;
