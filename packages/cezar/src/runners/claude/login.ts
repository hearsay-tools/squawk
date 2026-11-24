import type { RunnerLoginData } from '@hearsay-tools/squawk/plugin';

/** Claude's login and auth-status data (the `login` part). Data only: the definition and
 *  `ProviderAuthService` read this value, so importing it loads no code. */
export const CLAUDE_LOGIN = {
  statusArgs: ['auth', 'status', '--json'],
  loginArgs: ['auth', 'login'],
  installHint: 'Install Claude Code, then run `claude auth login`.',
} as const satisfies RunnerLoginData;
