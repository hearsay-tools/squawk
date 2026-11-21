import type { RunnerLoginData } from '../../core/runner-definition.ts';
export const ANTIGRAVITY_LOGIN = {
  statusArgs: ['--version'], loginArgs: ['--uid='],
  installHint: 'Install the Antigravity ACP registry archive. Configure your sign-in outside Squawk.',
} as const satisfies RunnerLoginData;
