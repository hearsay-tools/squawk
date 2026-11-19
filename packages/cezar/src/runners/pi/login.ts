import type { RunnerLogin } from '../../core/runner-definition.ts';

/** Pi's login and auth-status data (the `login` part). Data only: the definition and
 *  `ProviderAuthService` read this value, so importing it loads no code. */
export const PI_LOGIN = {
  executable: { env: 'PI_BIN', fallback: 'pi' },
  statusArgs: ['--list-models'],
  loginArgs: ['/login'],
  installHint: 'Install pi, then run `pi /login`.',
} as const satisfies RunnerLogin;
