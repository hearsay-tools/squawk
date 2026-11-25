import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';
import { productEnv } from '@hearsay-tools/squawk/plugin';

/** Resolve discovery and execution through the same binary and dry-run precedence. */
export function resolveClaudeExecutable(override?: string): string {
  return override ?? productEnv('CLAUDE_BIN') ??
    (productEnv('DRY_RUN') === '1' ? mockClaudePath() : 'claude');
}

/** Path to the bundled mock (`scripts/mock-claude.mjs`), for CEZ_DRY_RUN=1. */
function mockClaudePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here = <pkg>/dist/runners/claude (built) or <pkg>/src/runners/claude (tsx dev).
  return resolvePath(here, '..', '..', '..', 'scripts', 'mock-claude.mjs');
}
