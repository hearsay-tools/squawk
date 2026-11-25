import { MULTI_PROVIDER_PREFIXES, type RunnerEnv } from '@hearsay-tools/squawk/plugin';

/** OpenCode's env allow-list (the `env` part). Data only. */
export const OPENCODE_ENV = { allowPrefixes: MULTI_PROVIDER_PREFIXES } as const satisfies RunnerEnv;
