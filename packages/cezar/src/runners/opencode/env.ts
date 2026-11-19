import type { RunnerEnv } from '../../core/runner-definition.ts';
import { MULTI_PROVIDER_PREFIXES } from '../../core/agent-env.ts';

/** OpenCode's env allow-list (the `env` part). Data only. */
export const OPENCODE_ENV = { allowPrefixes: MULTI_PROVIDER_PREFIXES } as const satisfies RunnerEnv;
