import { join } from 'node:path';
import type { ProviderId } from './provider-auth.ts';
import type { AccountLayout } from './runner-definition.ts';
import { registeredRunners, runnerDefinition } from './runner-registry.ts';

/**
 * Pure native account-home mappings, read from the runner registry (spec
 * 2026-11-18-runner-definitions: the `accounts` part of each definition, `runners/<id>/accounts.ts`).
 * Keep file-catalog knowledge separate from account relocation. Workspace code resolves saved
 * accounts; runners, auth and terminal handoff consume this mapping.
 */

/** The account layout a registered runner declares (its definition's `accounts.layout`). */
export function accountLayout(provider: ProviderId): AccountLayout {
  return runnerDefinition(provider).accounts.layout;
}

/** The variable that selects a named account for `provider`; null means named accounts are
 *  unsupported. Was `PROFILE_ENV_VAR[provider]`, built at import from `ACCOUNT_LAYOUT`. */
export function profileEnvVar(provider: ProviderId): string | null {
  return runnerDefinition(provider).accounts.layout.envVar;
}

/** Providers that can carry more than one account — what the UI offers "Add account" for. Was
 *  `PROFILE_CAPABLE_PROVIDERS`, built at import; now the registered runners that declare an
 *  account variable, in registration order. */
export function profileCapableProviders(): ProviderId[] {
  return registeredRunners()
    .map(({ id }) => id)
    .filter((id) => profileEnvVar(id) !== null);
}

export function supportsProfiles(provider: ProviderId): boolean {
  return profileEnvVar(provider) !== null;
}

/**
 * Build a provider-specific account override, or an empty object for the discovered default.
 * Never emit another provider’s variable.
 */
export function profileEnv(provider: ProviderId, configDir: string | null | undefined): Record<string, string> {
  const envVar = profileEnvVar(provider);
  const dir = configDir?.trim();
  if (envVar === null || !dir) return {};
  const paths = runnerDefinition(provider).accounts.layout.envPaths ?? {};
  return { [envVar]: dir, ...Object.fromEntries(Object.entries(paths).map(([name, relative]) => [name, join(dir, relative)])) };
}

/**
 * Does `entries` look like a config dir this provider actually wrote?
 *
 * ADVISORY, never a gate. The honest first-run flow for a second account is *add the profile →
 * Connect → the CLI creates the dir on login*, so refusing an unrecognized directory would break
 * the very case the feature exists for. The answer drives a warning line in the UI, nothing more.
 *
 * Takes the directory listing rather than a path so it stays pure; the caller reads the dir.
 */
export function looksLikeProfileDir(provider: ProviderId, entries: readonly string[]): boolean {
  const present = new Set(entries);
  const markers = runnerDefinition(provider).accounts.dirMarkers;
  return markers.some((marker) => present.has(marker));
}
