import type { RunnerLoginData } from '../../core/runner-definition.ts';

/** OpenCode's login and auth-status data (the `login` part). Data only: the definition and
 *  `ProviderAuthService` read this value, so importing it loads no code. */
export const OPENCODE_LOGIN = {
  statusArgs: ['auth', 'list'],
  loginArgs: ['auth', 'login'],
  installHint: 'Install OpenCode, then run `opencode auth login`.',
} as const satisfies RunnerLoginData;
