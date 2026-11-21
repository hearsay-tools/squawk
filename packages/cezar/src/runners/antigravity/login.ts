import type { RunnerLoginData } from '../../core/runner-definition.ts';
export const ANTIGRAVITY_LOGIN = {
  statusArgs: ['--version'], loginArgs: ['--uid='],
  installHint: 'Install the Antigravity ACP registry archive. Set GEMINI_API_KEY or GOOGLE_API_KEY, or sign in to Antigravity under GEMINI_HOME (default ~/.gemini).',
} as const satisfies RunnerLoginData;
