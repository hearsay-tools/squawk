import type { ProviderId } from './provider-auth.ts';

/**
 * Pure native account-home mappings. Keep file-catalog knowledge separate from account
 * relocation. Workspace code resolves saved accounts; runners, auth and terminal handoff consume
 * this mapping.
 */

/** How one provider lays out an account, declared once per provider id. */
export interface AccountLayout {
  /**
   * The variable Squawk sets to the account folder so the CLI opens that login. null: the provider
   * carries no named accounts.
   */
  readonly envVar: string | null;
  /**
   * Whether a worker binding of the default account pins its discovered home. false: the default
   * spawns bare and follows the host env. A machine where the agent never ran has no home to pin.
   */
  readonly defaultBindsHome: boolean;
  /**
   * Where the login state file sits for the discovered home. `beside-home`: next to it (Claude's
   * `.claude.json`, see `claudeStateFilePath`), so a worker binds the home the child env resolves
   * and records that layout. `in-home`: inside the account folder.
   */
  readonly stateFile: 'in-home' | 'beside-home';
}

/** Account relocation per provider. Host values define the default; named overrides apply last. */
export const ACCOUNT_LAYOUT: Readonly<Record<ProviderId, AccountLayout>> = {
  claude: { envVar: 'CLAUDE_CONFIG_DIR', defaultBindsHome: true, stateFile: 'beside-home' },
  codex: { envVar: 'CODEX_HOME', defaultBindsHome: true, stateFile: 'in-home' },
  opencode: { envVar: null, defaultBindsHome: false, stateFile: 'in-home' },
  pi: { envVar: 'PI_CODING_AGENT_DIR', defaultBindsHome: false, stateFile: 'in-home' },
  // omp selects a login by profile NAME under its own root, not by folder, so it carries no named
  // accounts; a host `OMP_PROFILE` still moves its discovered default (`agentHomePaths`).
  omp: { envVar: null, defaultBindsHome: false, stateFile: 'in-home' },
};

/** The variable that selects a named account per provider; null means named accounts are unsupported. */
export const PROFILE_ENV_VAR = Object.fromEntries(
  Object.entries(ACCOUNT_LAYOUT).map(([provider, layout]) => [provider, layout.envVar]),
) as Readonly<Record<ProviderId, string | null>>;

/** Providers that can carry more than one account — what the UI offers "Add account" for. */
export const PROFILE_CAPABLE_PROVIDERS: readonly ProviderId[] = (
  Object.keys(PROFILE_ENV_VAR) as ProviderId[]
).filter((provider) => PROFILE_ENV_VAR[provider] !== null);

export function supportsProfiles(provider: ProviderId): boolean {
  return PROFILE_ENV_VAR[provider] !== null;
}

/**
 * Build a provider-specific account override, or an empty object for the discovered default.
 * Never emit another provider’s variable.
 */
export function profileEnv(provider: ProviderId, configDir: string | null | undefined): Record<string, string> {
  const envVar = PROFILE_ENV_VAR[provider];
  const dir = configDir?.trim();
  return envVar === null || !dir ? {} : { [envVar]: dir };
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
  const markers = PROFILE_DIR_MARKERS[provider];
  return markers.some((marker) => present.has(marker));
}

/** What each agent drops into its home on first login. Any one is enough. */
const PROFILE_DIR_MARKERS: Record<ProviderId, readonly string[]> = {
  // `.claude.json` sits INSIDE the dir once it is overridden (see `claudeStateFilePath`), which
  // is exactly the case being probed here.
  claude: ['.claude.json', 'settings.json', 'projects', 'sessions'],
  codex: ['auth.json', 'config.toml'],
  // OpenCode cannot carry profiles (`PROFILE_ENV_VAR.opencode === null`); the discovered config
  // dir is probed, but nothing it holds marks a login.
  opencode: [],
  pi: ['auth.json', 'settings.json', 'models.json', 'sessions'],
  // omp carries no named accounts; the discovered default is an agent dir.
  omp: ['agent.db', 'config.yml', 'sessions'],
};
