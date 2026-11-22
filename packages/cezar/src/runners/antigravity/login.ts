import type { RunnerLoginData } from '../../core/runner-definition.ts';
export const ANTIGRAVITY_LOGIN = {
  statusArgs: ['--version'], loginArgs: null,
  installHint: 'Install the Antigravity CLI from Settings > Agents > Install CLI, or put agy on PATH. Then set GEMINI_API_KEY or GOOGLE_API_KEY, or connect a personal Google account.',
} as const satisfies RunnerLoginData;
