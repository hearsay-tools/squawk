import { productEnv } from '@hearsay-tools/squawk/plugin';
import { nativeMockPath } from '@hearsay-tools/squawk/plugin/runtime';
import { CLAUDE_MOCK } from './mock.ts';

/** Resolve discovery and execution through the same binary and dry-run precedence. */
export function resolveClaudeExecutable(override?: string): string {
  return override ?? productEnv('CLAUDE_BIN') ??
    (productEnv('DRY_RUN') === '1' ? nativeMockPath(CLAUDE_MOCK) : 'claude');
}
