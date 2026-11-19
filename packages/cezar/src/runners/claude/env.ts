import type { RunnerEnv } from '../../core/runner-definition.ts';

/** Claude's env allow-list (the `env` part). Data only. */
export const CLAUDE_ENV = { allowPrefixes: ['ANTHROPIC_', 'CLAUDE_'] } as const satisfies RunnerEnv;
