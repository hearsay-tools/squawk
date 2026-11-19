import type { RunnerEnv } from '../../core/runner-definition.ts';
import { MULTI_PROVIDER_PREFIXES } from '../../core/agent-env.ts';

/** Pi's env allow-list (the `env` part). Data only. */
export const PI_ENV = {
  allowPrefixes: [
    // pi selects models as `provider/model` (#387), so it needs both its own config and any
    // provider a configured model id can name — the same set OpenCode gets, for the same reason.
    // Deliberately NOT `CLAUDE_`: pi is not Claude Code and reads none of its variables, and the
    // prefix is load-bearing below — it is what unlocks the Bedrock/Vertex cloud credentials, so
    // granting it here handed pi the whole `AWS_*` / `GOOGLE_CLOUD_*` family on any host that had
    // set `CLAUDE_CODE_USE_BEDROCK=1` for Claude Code, plus Claude's own config dir.
    'PI_',
    ...MULTI_PROVIDER_PREFIXES,
  ],
} as const satisfies RunnerEnv;
