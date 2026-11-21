import type { RunnerEnv } from '../../core/runner-definition.ts';
export const ANTIGRAVITY_ENV = { allowPrefixes: ['GEMINI_', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_API_KEY', 'AGY_', 'ANTIGRAVITY_'] } as const satisfies RunnerEnv;
