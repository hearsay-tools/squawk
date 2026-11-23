import type { Home } from '../home/home.ts';
import type { ProviderAuthService, ProviderId } from '../core/provider-auth.ts';
import { resolveRunnerId } from '../core/runner-registry.ts';
import { DEFAULT_RUNNER_ID } from '../core/runner-ids.ts';
import type { RunRecord } from '../runs/store.ts';
import { executionAccount } from '../workflows/execution-account.ts';
import { latestSession, workerContinuationStep } from '@open-mercato/cezar-contract/run-predicates';
import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-contract/agent-profiles';
import { loadAgentAccounts } from '../workspace/agent-accounts.ts';
import { selectProfile, type ResolvedAgentProfile } from '../workspace/agent-profiles.ts';
import { providerForExistingRun, type GateAccount } from './provider-action-gate.ts';

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
 * Where a start's accounts come from: the project (its selection), an existing run, and explicit
 * picks, which win. A run is read as a live session (`live`: a message to it) or as a continuation
 * from its `original` runner to its `target` runner.
 */
export interface AccountScope {
  repoRoot: string;
  run?: RunRecord | undefined;
  live?: boolean | undefined;
  untouched?: boolean | undefined;
  runners?: ContinueRunners | undefined;
  picks?: Partial<Record<ProviderId, string | undefined>> | undefined;
}

/** {@link namedRunAccounts} for an {@link AccountScope}. */
export function scopeRunAccounts(
  home: Home,
  required: readonly ProviderId[],
  { repoRoot, run, live, untouched, runners, picks = {} }: AccountScope,
): Promise<Map<ProviderId, ResolvedAgentProfile>> {
  const fromRun = (provider: ProviderId) => run === undefined ? undefined
    : live ? liveAccountFor(run, provider) : runAccountFor(run, provider, runners, untouched);
  const chosen = Object.fromEntries(required.map((provider) => [provider, picks[provider] ?? fromRun(provider)]));
  return namedRunAccounts(home, repoRoot, required, chosen);
}

/** The account a message to a live run's session on `provider` reaches: the latest session's. */
export function liveAccountFor(run: RunRecord, provider: ProviderId): string | undefined {
  const live = executionAccount(run);
  return resolveRunnerId(live.runner ?? DEFAULT_RUNNER_ID) === provider ? live.agentProfile : undefined;
}

/** A continuation's runners: the run's own (`original`) and the one it continues on (`target`). */
export interface ContinueRunners {
  original: ProviderId;
  target: ProviderId;
}

function workerAccountFor(run: RunRecord, provider: ProviderId, original: ProviderId, target: ProviderId, untouched: boolean): string | undefined {
  if (untouched) {
    const match = run.workflowDef?.steps.find(step =>
      step.command === undefined && step.kind !== 'plugin' && resolveRunnerId(step.runner ?? run.runner) === provider);
    return match?.agentProfile ?? (provider === original ? run.agentProfile : undefined);
  }
  if (provider !== target) return undefined;
  return workerContinuationStep(run)?.agentProfile;
}

/**
 * The account a continuation's turn on `provider` uses, as the engine picks it (`sessionAffinity`,
 * `overridePatch`, `agentEnvForStep`). The target runner resumes the latest session when that session
 * ran on it and the run's own account, if any, is the session's account (`default` when none was
 * recorded). Otherwise the target runner starts fresh on the run's account, which a runner switch
 * clears first; every other runner uses the project's selection (absent).
 */
export function runAccountFor(run: RunRecord, provider: ProviderId, runners?: ContinueRunners, untouched = false): string | undefined {
  const original = runners?.original ?? providerForExistingRun(run);
  const target = runners?.target ?? original;
  if (run.delegation?.role === 'worker') {
    const pinned = workerAccountFor(run, provider, original, target, untouched);
    if (pinned !== undefined || untouched) return pinned;
  }
  if (provider !== target) return undefined;
  const session = latestSession(run);
  const sessionAccount = session.profileId ?? DEFAULT_AGENT_ACCOUNT_ID;
  const resumes = session.sessionId !== undefined && resolveRunnerId(session.backend) === target
    && (run.agentProfile ?? sessionAccount) === sessionAccount;
  if (resumes) return sessionAccount;
  return target === original ? run.agentProfile : undefined;
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
