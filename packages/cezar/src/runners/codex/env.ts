import type { RunnerEnv } from '@hearsay-tools/squawk/plugin';

/** Codex's env allow-list (the `env` part). Data only. */
export const CODEX_ENV = { allowPrefixes: ['OPENAI_', 'CODEX_', 'AZURE_OPENAI_'] } as const satisfies RunnerEnv;
