import type {
  ProviderId,
  ProviderStatusResponse,
  WorkspaceUiState,
} from '@open-mercato/cezar-api-client'
import type { RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'

export interface ProviderAuthIncident {
  provider: ProviderId
  label: string
  authFailureId: string
}

export type ProviderAuthDismissals = NonNullable<
  WorkspaceUiState['dismissedProviderAuthFailures']
>

/** The stored dismissals of the registered runners whose ids are valid. */
export function providerAuthDismissals(
  value: unknown,
  runners: RunnersResponse | undefined,
): ProviderAuthDismissals {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const dismissals: ProviderAuthDismissals = {}
  for (const { id: provider } of runners?.runners ?? []) {
    const id = record[provider]
    if (typeof id === 'string' && id.length > 0 && id.length <= 128) {
      dismissals[provider] = id
    }
  }
  return dismissals
}

/** The undismissed incidents, in the runners list's display order. None until both the status
 *  and the runners list have answered. */
export function visibleProviderAuthIncidents(
  status: ProviderStatusResponse | undefined,
  dismissals: ProviderAuthDismissals,
  runners: RunnersResponse | undefined,
): ProviderAuthIncident[] {
  if (!status || !runners) return []
  const rows = new Map(status.providers.map((row) => [row.provider, row]))
  return runners.runners.flatMap(({ id: provider, displayName }) => {
    const row = rows.get(provider)
    if (
      row?.status !== 'disconnected'
      || !row.authFailureId
      || dismissals[provider] === row.authFailureId
    ) return []
    return [{
      provider,
      label: displayName,
      authFailureId: row.authFailureId,
    }]
  })
}

export function mergeProviderAuthDismissals(
  current: ProviderAuthDismissals,
  incidents: readonly ProviderAuthIncident[],
): ProviderAuthDismissals {
  return {
    ...current,
    ...Object.fromEntries(incidents.map(({ provider, authFailureId }) => [
      provider,
      authFailureId,
    ])),
  }
}
