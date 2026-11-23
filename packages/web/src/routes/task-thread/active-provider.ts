import { controlLocation } from '@open-mercato/cezar-api-client/contract/control-locations'
import { providerForActiveRun } from '@open-mercato/cezar-api-client/contract/active-provider'
import type { RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'
import type { ApiRun, ProviderStatusResponse, Runner } from '@open-mercato/cezar-api-client'
import { latestSession } from '@open-mercato/cezar-api-client/contract/run-predicates'
import { DEFAULT_AGENT_ACCOUNT_ID } from '@open-mercato/cezar-api-client/contract/agent-profiles'
import { useAgentAccounts } from '@/api/agent-accounts'
import { useProviderStatus } from '@/api/queries'
import { runnerDisplayName, useRunners } from '@/api/runners'
import type { RunnerAccountChoice } from '@/components/picker-pill'
import { providerStatusFor } from '@/lib/provider-status'

/** Mirrors the server's providerForExistingRun for an override-free POST /continue. */
export function providerForExistingRun(run: ApiRun): Runner {
  return run.runner ?? 'claude'
}

/** A continuation's runners: the run's own (`original`) and the one it continues on (`target`). */
export interface ContinueRunners {
  original: Runner
  target: Runner
}

/**
 * The account id a continuation's turn on `provider` uses, mirroring the server's `runAccountFor`:
 * the target runner resumes the latest session's account when that session ran on it and the run's
 * own account, if any, matches; otherwise it starts fresh on the run's account, which a runner switch
 * clears. Every other runner, and a cleared account, uses the project's selection. `undefined`
 * means the default account.
 */
export function runAccountId(
  run: ApiRun,
  provider: Runner,
  repoAccount: Partial<Record<Runner, string>> | undefined,
  runners?: ContinueRunners,
): string | undefined {
  const original = runners?.original ?? run.runner ?? 'claude'
  const target = runners?.target ?? original
  if (provider !== target) return repoAccount?.[provider]
  const session = latestSession(run)
  const sessionAccount = session.profileId ?? DEFAULT_AGENT_ACCOUNT_ID
  const resumes = session.sessionId !== undefined && session.backend === target
    && (run.agentProfile ?? sessionAccount) === sessionAccount
  if (resumes) return sessionAccount
  return (target === original ? run.agentProfile : undefined) ?? repoAccount?.[provider]
}

/** The account id a message to a live run's session on `provider` reaches, mirroring the server's
 *  `liveAccountFor`: the latest session's account, else the project's selection. */
export function liveAccountId(
  run: ApiRun,
  provider: Runner,
  repoAccount: Partial<Record<Runner, string>> | undefined,
): string | undefined {
  const session = latestSession(run)
  const live = session.sessionId === undefined
    ? { runner: run.runner ?? 'claude', account: run.agentProfile }
    : { runner: session.backend, account: session.profileId ?? run.agentProfile }
  return (live.runner === provider ? live.account : undefined) ?? repoAccount?.[provider]
}

/** The named account `id` names for `provider`; `undefined` for the default account. */
function namedAccount(
  accounts: readonly RunnerAccountChoice[],
  provider: Runner,
  id: string | undefined,
): RunnerAccountChoice | undefined {
  const account = accounts.find((choice) => choice.provider === provider && choice.id === id)
  return account?.isDefault ? undefined : account
}

/** The named account {@link runAccountId} names; `undefined` for the default account. */
export function runAccountChoice(
  run: ApiRun,
  provider: Runner,
  accounts: readonly RunnerAccountChoice[],
  repoAccount: Partial<Record<Runner, string>> | undefined,
): RunnerAccountChoice | undefined {
  return namedAccount(accounts, provider, runAccountId(run, provider, repoAccount))
}

type Availability = { provider: Runner; usable: boolean; reason?: string | undefined }

function providerAvailability(
  provider: Runner,
  status: ProviderStatusResponse,
  runners: RunnersResponse,
  account?: RunnerAccountChoice | undefined,
): Availability {
  const row = providerStatusFor(status, provider)
  if (row?.enabled === false) {
    return {
      provider,
      usable: false,
      reason: `${runnerDisplayName(runners, provider)} is disabled. Enable it in ${controlLocation('providers')}.`,
    }
  }
  // A named account answers for itself: the provider row describes the default account only
  // (hearsay-tools/squawk#4116). One not probed yet is left to the server's gate.
  if (account && row?.authFailureId === undefined) {
    if (account.status === undefined || account.status === 'connected') return { provider, usable: true }
    return {
      provider,
      usable: false,
      reason: `${runnerDisplayName(runners, provider)} account "${account.label}" is not signed in. Sign in in ${controlLocation('providers')}.`,
    }
  }
  if (row?.status !== 'connected') {
    return {
      provider,
      usable: false,
      reason: `${runnerDisplayName(runners, provider)} credentials are unavailable. Authorize it in ${controlLocation('providers')}.`,
    }
  }
  return { provider, usable: true }
}

export function activeProviderAvailability(
  run: ApiRun,
  status: ProviderStatusResponse,
  runners: RunnersResponse,
  account?: RunnerAccountChoice | undefined,
): Availability {
  return providerAvailability(providerForActiveRun(run), status, runners, account)
}

export function existingProviderAvailability(
  run: ApiRun,
  status: ProviderStatusResponse,
  runners: RunnersResponse,
  account?: RunnerAccountChoice | undefined,
): Availability {
  return providerAvailability(providerForExistingRun(run), status, runners, account)
}

/** Availability for the same provider the server will use for a live/queued message. */
export function useActiveProviderAvailability(run: ApiRun) {
  const status = useProviderStatus()
  const runners = useRunners().data
  const provider = providerForActiveRun(run)
  const { accounts, repoAccount } = useAgentAccounts()
  const account = namedAccount(accounts, provider, liveAccountId(run, provider, repoAccount))
  // Do not strand an existing task while the availability query or the runners list is loading
  // or retrying; the server remains the boundary for a stale client. Once a complete response
  // arrives, mirror its fixed action gate exactly.
  return status.isSuccess && status.data && runners
    ? activeProviderAvailability(run, status.data, runners, account)
    : { provider, usable: true }
}

/** Availability for the run's recorded provider, which an override-free continuation keeps. */
export function useExistingProviderAvailability(run: ApiRun) {
  const status = useProviderStatus()
  const runners = useRunners()
  const provider = providerForExistingRun(run)
  const { accounts, repoAccount } = useAgentAccounts()
  const account = runAccountChoice(run, provider, accounts, repoAccount)
  if (status.isSuccess && status.data && runners.data) return existingProviderAvailability(run, status.data, runners.data, account)
  if (status.isError || runners.isError) {
    return {
      provider,
      usable: false,
      reason: 'Provider authentication could not be verified.',
    }
  }
  return {
    provider,
    usable: false,
    reason: 'Checking agent providers…',
  }
}
