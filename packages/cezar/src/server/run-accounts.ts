import type { Home } from '../home/home.ts';
import type { ProviderAuthService, ProviderId } from '../core/provider-auth.ts';
import { resolveRunnerId } from '../core/runner-registry.ts';
import { DEFAULT_RUNNER_ID } from '../core/runner-ids.ts';
import type { RunRecord } from '../runs/store.ts';
import { latestSession } from '@open-mercato/cezar-contract/run-predicates';
import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-contract/agent-profiles';
import { loadAgentAccounts } from '../workspace/agent-accounts.ts';
import { selectProfile, type ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import type { GateAccount } from './provider-action-gate.ts';

/**
 * The NAMED (non-default) account each provider of a start will run on (hearsay-tools/squawk#4116).
 *
 * The provider-status row speaks for the default account only. The start gate reads this map to
 * check the account the task actually uses: an explicit pick in `picks`, else the project's
 * selection. A provider that runs on its default account is absent. An unreadable account file
 * degrades to "every provider runs on its default account", as run resolution does.
 */
export async function namedRunAccounts(
  home: Home,
  repoRoot: string,
  providers: readonly ProviderId[],
  picks: Partial<Record<ProviderId, string | undefined>> = {},
): Promise<Map<ProviderId, ResolvedAgentProfile>> {
  const named = new Map<ProviderId, ResolvedAgentProfile>();
  const store = await loadAgentAccounts(home).catch(() => null);
  if (store === null) return named;
  for (const provider of providers) {
    // No stored account for this provider: it can only run on its default account.
    if (!store.accounts.some((account) => account.provider === provider)) continue;
    const profile = selectProfile(store, { provider, repoRoot, profileId: picks[provider] });
    if (!profile.isDefault) named.set(provider, profile);
  }
  return named;
}

/**
 * Where a start's accounts come from: the project (its selection), an existing run (the account its
 * next turn uses), and explicit picks, which win.
 */
export interface AccountScope {
  repoRoot: string;
  run?: RunRecord | undefined;
  picks?: Partial<Record<ProviderId, string | undefined>> | undefined;
}

/** {@link namedRunAccounts} for an {@link AccountScope}. */
export function scopeRunAccounts(
  home: Home,
  required: readonly ProviderId[],
  { repoRoot, run, picks = {} }: AccountScope,
): Promise<Map<ProviderId, ResolvedAgentProfile>> {
  const chosen = Object.fromEntries(required.map((provider) =>
    [provider, picks[provider] ?? (run ? runAccountFor(run, provider) : undefined)]));
  return namedRunAccounts(home, repoRoot, required, chosen);
}

/**
 * The account an existing run's next turn on `provider` uses, as the engine picks it
 * (`sessionAffinity`, `overridePatch`, `agentEnvForStep`). The turn resumes the latest session when
 * that session ran on `provider` and the run's own account, if any, is the session's account; it then
 * uses the session's account (`default` when none was recorded). Otherwise it starts fresh: on the
 * run's runner with the run's account, and on any other runner with the project's selection
 * (absent), because a runner switch clears the run's account.
 */
export function runAccountFor(run: RunRecord, provider: ProviderId): string | undefined {
  const session = latestSession(run);
  const sessionAccount = session.profileId ?? DEFAULT_AGENT_ACCOUNT_ID;
  const resumes = session.sessionId !== undefined && resolveRunnerId(session.backend) === provider
    && (run.agentProfile ?? sessionAccount) === sessionAccount;
  if (resumes) return sessionAccount;
  return provider === resolveRunnerId(run.runner ?? DEFAULT_RUNNER_ID) ? run.agentProfile : undefined;
}

/** The probed sign-in state of each named account in `accounts`. `refresh` drops the cached answer
 *  first for the providers it names, so a refusal is confirmed by a fresh probe, as the default rows
 *  are, and a provider with a standing runtime incident is never answered from an older cache. */
export async function probeNamedAccounts(
  providerAuth: Pick<ProviderAuthService, 'profileStatus' | 'forgetProfileStatus'>,
  accounts: ReadonlyMap<ProviderId, ResolvedAgentProfile>,
  refresh: (provider: ProviderId) => boolean = () => false,
): Promise<Map<ProviderId, GateAccount>> {
  const rows = await Promise.all([...accounts].map(async ([provider, account]) => {
    if (refresh(provider)) providerAuth.forgetProfileStatus(provider, account.id);
    const probed = await providerAuth.profileStatus(provider, { id: account.id, configDir: account.path });
    return [provider, { label: account.label, status: probed.status }] as const;
  }));
  return new Map(rows);
}
