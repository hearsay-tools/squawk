import { controlLocation } from '@open-mercato/cezar-api-client/contract/control-locations'
import { providerForActiveRun } from '@open-mercato/cezar-api-client/contract/active-provider'
import type { RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'
import type { ApiRun, ProviderStatusResponse, Runner } from '@open-mercato/cezar-api-client'
import { useProviderStatus } from '@/api/queries'
import { runnerDisplayName, useRunners } from '@/api/runners'
import { providerStatusFor } from '@/lib/provider-status'

/** Mirrors the server's providerForExistingRun for an override-free POST /continue. */
export function providerForExistingRun(run: ApiRun): Runner {
  return run.runner ?? 'claude'
}

function providerAvailability(
  provider: Runner,
  status: ProviderStatusResponse,
  runners: RunnersResponse,
): { provider: Runner; usable: boolean; reason?: string | undefined } {
  const row = providerStatusFor(status, provider)
  if (row?.enabled === false) {
    return {
      provider,
      usable: false,
      reason: `${runnerDisplayName(runners, provider)} is disabled. Enable it in ${controlLocation('providers')}.`,
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
): { provider: Runner; usable: boolean; reason?: string | undefined } {
  return providerAvailability(providerForActiveRun(run), status, runners)
}

export function existingProviderAvailability(
  run: ApiRun,
  status: ProviderStatusResponse,
  runners: RunnersResponse,
): { provider: Runner; usable: boolean; reason?: string | undefined } {
  return providerAvailability(providerForExistingRun(run), status, runners)
}

/** Availability for the same provider the server will use for a live/queued message. */
export function useActiveProviderAvailability(run: ApiRun) {
  const status = useProviderStatus()
  const runners = useRunners().data
  const provider = providerForActiveRun(run)
  // Do not strand an existing task while the availability query or the runners list is loading
  // or retrying; the server remains the boundary for a stale client. Once a complete response
  // arrives, mirror its fixed action gate exactly.
  return status.isSuccess && status.data && runners
    ? activeProviderAvailability(run, status.data, runners)
    : { provider, usable: true }
}

/** Availability for the run's recorded provider, which an override-free continuation keeps. */
export function useExistingProviderAvailability(run: ApiRun) {
  const status = useProviderStatus()
  const runners = useRunners()
  const provider = providerForExistingRun(run)
  if (status.isSuccess && status.data && runners.data) return existingProviderAvailability(run, status.data, runners.data)
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
