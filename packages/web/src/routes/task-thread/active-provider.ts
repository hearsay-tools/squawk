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

/**
 * The account id a run's next turn on `provider` uses, mirroring the server's `runAccountFor`: a turn
 * resuming the latest session uses its account (`default` when none was recorded) unless the run's
 * own account differs; a fresh turn on the run's runner uses the run's account; any other provider
 * the project's selection. `undefined` means the default account.
 */
export function runAccountId(
  run: ApiRun,
  provider: Runner,
  repoAccount: Partial<Record<Runner, string>> | undefined,
): string | undefined {
  const runAccount = provider === (run.runner ?? 'claude') ? run.agentProfile : undefined
  const session = latestSession(run)
  if (session.sessionId === undefined || session.backend !== provider) return runAccount ?? repoAccount?.[provider]
  return runAccount ?? session.profileId ?? DEFAULT_AGENT_ACCOUNT_ID
}

/** The named account {@link runAccountId} names; `undefined` for the default account. */
export function runAccountChoice(
  run: ApiRun,
  provider: Runner,
  accounts: readonly RunnerAccountChoice[],
  repoAccount: Partial<Record<Runner, string>> | undefined,
): RunnerAccountChoice | undefined {
  const id = runAccountId(run, provider, repoAccount)
  const account = accounts.find((choice) => choice.provider === provider && choice.id === id)
  return account?.isDefault ? undefined : account
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
  if (account) {
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
  const account = runAccountChoice(run, provider, accounts, repoAccount)
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
