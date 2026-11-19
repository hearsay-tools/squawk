import type { ProviderCommandResult, ProviderConnectionState } from '../../core/provider-auth.ts';

/** Claude's auth-status parser, moved verbatim from `core/provider-auth.ts`. Loads only through
 *  the definition's `loadLogin()`. */
export function parseClaudeStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  try {
    const value = JSON.parse(result.stdout) as { loggedIn?: unknown };
    if (value.loggedIn === true && result.exitCode === 0) return 'connected';
    if (value.loggedIn === false && result.exitCode === 1) return 'disconnected';
    return null;
  } catch {
    return null;
  }
}
