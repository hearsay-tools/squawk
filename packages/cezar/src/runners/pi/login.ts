import type { RunnerLoginData } from '@hearsay-tools/squawk/plugin';

/** Pi's login and auth-status data (the `login` part). Data only: the definition and
 *  `ProviderAuthService` read this value, so importing it loads no code. */
export const PI_LOGIN = {
  statusArgs: ['--list-models'],
  loginArgs: ['/login'],
  installHint: 'Install pi, then run `pi /login`.',
} as const satisfies RunnerLoginData;
