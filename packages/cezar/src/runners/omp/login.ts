import type { RunnerLoginData } from '@hearsay-tools/squawk/plugin';

/** OMP's login and auth-status data (the `login` part). Data only: the definition and
 *  `ProviderAuthService` read this value, so importing it loads no code. */
export const OMP_LOGIN = {
  statusArgs: ['models', '--json'],
  loginArgs: ['login'],
  installHint: 'Install OMP (curl -fsSL https://omp.sh/install | sh), then run `omp login`.',
  // `omp models --json` lists every model of every configured provider at ~350 bytes each:
  // OpenRouter alone is 561 models (~200 KB) on v18.4.11, and four keys pass 256 KiB. An
  // overflow answers `unknown`, which hides a logged-in OMP from every picker (Ruling 19).
  maxBuffer: 4 * 1024 * 1024,
} as const satisfies RunnerLoginData;
