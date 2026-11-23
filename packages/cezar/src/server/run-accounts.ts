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
 * (`sessionAffinity`, `agentEnvForStep`). A turn that resumes the latest session uses that
 * session's account (`default` when none was recorded), unless the run's own account differs, which
 * starts a fresh session on the run's account. A fresh turn on the run's runner uses the run's
 * account. Absent means the project's selection, the engine's fallback for any other provider.
 */
export function runAccountFor(run: RunRecord, provider: ProviderId): string | undefined {
  const runRunner = resolveRunnerId(run.runner ?? DEFAULT_RUNNER_ID);
  const runAccount = provider === runRunner ? run.agentProfile : undefined;
  const session = latestSession(run);
  if (session.sessionId === undefined || resolveRunnerId(session.backend) !== provider) return runAccount;
  return runAccount ?? session.profileId ?? DEFAULT_AGENT_ACCOUNT_ID;
}

/** The probed sign-in state of each named account in `accounts`. `refresh` drops the cached answer
 *  first, so a refusal is confirmed by a fresh probe, as the default rows are. */
export async function probeNamedAccounts(
  providerAuth: Pick<ProviderAuthService, 'profileStatus' | 'forgetProfileStatus'>,
  accounts: ReadonlyMap<ProviderId, ResolvedAgentProfile>,
  refresh = false,
): Promise<Map<ProviderId, GateAccount>> {
  const rows = await Promise.all([...accounts].map(async ([provider, account]) => {
    if (refresh) providerAuth.forgetProfileStatus(provider, account.id);
    const probed = await providerAuth.profileStatus(provider, { id: account.id, configDir: account.path });
    return [provider, { label: account.label, status: probed.status }] as const;
  }));
  return new Map(rows);
}
