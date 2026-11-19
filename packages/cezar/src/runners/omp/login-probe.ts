import type { ProviderCommandResult, ProviderConnectionState } from '../../core/provider-auth.ts';

/**
 * OMP (Oh My Pi) v18.4.11: `omp models --json` exits 0 and prints `{"models":[...]}` — an object
 * wrapping the array, not a bare array. With no credentials the array is empty; with any provider
 * key (stored login or an environment variable) it lists that provider's models. Like OpenCode's
 * environment count, a configured credential permits a run, so a non-empty list is `connected`;
 * a vendor rejection is still latched at runtime. Recorded from the real OMP v18.4.11 binary on
 * 2026-10-05 (`omp models --json`, no credentials, then with ANTHROPIC_API_KEY set); upstream is
 * `can1357/oh-my-pi` (tag v18.4.11, main @ 7318a70cf4ed), `docs/cli-reference.md` (models command).
 *
 * Moved verbatim from `core/provider-auth.ts`; loads only through the definition's `loadLogin()`.
 */
export function parseOmpStatus(result: ProviderCommandResult): ProviderConnectionState | null {
  if (result.exitCode !== 0) return null;
  try {
    const value = JSON.parse(result.stdout) as { models?: unknown };
    if (!Array.isArray(value?.models)) return null;
    return value.models.length > 0 ? 'connected' : 'disconnected';
  } catch {
    return null;
  }
}
