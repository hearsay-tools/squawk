import { XIcon } from 'lucide-react'

import type { ProviderStatusResponse } from '@open-mercato/cezar-api-client'
import type { RunnersResponse } from '@open-mercato/cezar-api-client/contract/runners'
import { Link } from '@/lib/project-router'
import {
  type ProviderAuthDismissals,
  type ProviderAuthIncident,
  visibleProviderAuthIncidents,
} from '@/lib/provider-auth-alert'
import { parseProviderStatusResponse, runnerSignedIn, type AccountSignIn } from '@/lib/provider-status'

import { StatusDot } from './status-dot'

interface ProviderBannerProps {
  status: ProviderStatusResponse | undefined
  /** The runners list: incidents name their runner, so they wait for it. */
  runners: RunnersResponse | undefined
  pending: boolean
  error: boolean
  dismissals: ProviderAuthDismissals
  onDismissAuthFailures: (incidents: readonly ProviderAuthIncident[]) => void
  /** Agent accounts with their sign-in state: a named account's sign-in counts as credentials. */
  accounts?: readonly AccountSignIn[]
}

export function ProviderBanner({
  status,
  runners,
  pending,
  error,
  dismissals,
  onDismissAuthFailures,
  accounts = [],
}: ProviderBannerProps) {
  if (pending || !status) return null
  let normalized: ProviderStatusResponse
  try {
    normalized = parseProviderStatusResponse(status)
  } catch {
    return null
  }

  const incidents = visibleProviderAuthIncidents(normalized, dismissals, runners)
  if (incidents.length > 0) {
    return (
      <div
        data-slot="provider-banner"
        role="alert"
        className="flex min-h-9 items-center gap-2 border-b border-border bg-destructive/10 px-4 text-sm text-foreground"
      >
        <StatusDot tone="danger" />
        <span>
          Provider authentication failed during a task:{' '}
          {incidents.map(({ label }) => label).join(', ')}.
        </span>
        <Link
          to="/settings/agent-defaults#providers"
          className="ml-auto shrink-0 font-medium underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open agent settings
        </Link>
        <button
          type="button"
          aria-label="Dismiss provider authentication alert"
          onClick={() => onDismissAuthFailures(incidents)}
          className="shrink-0 rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </div>
    )
  }

  if (error) return null
  const usable = normalized.providers.some(
    (row) => row.enabled && runnerSignedIn(row, accounts),
  )
  if (usable) return null
  const credentialsExist = normalized.providers.some(
    (row) => runnerSignedIn(row, accounts),
  )
  const uncertain = normalized.providers.some((row) => row.status === 'unknown')
  const message = credentialsExist
    ? 'No agent provider is enabled.'
    : uncertain
      ? 'No connected provider could be verified.'
      : 'No agent provider credentials were found.'

  return (
    <div
      data-slot="provider-banner"
      role="status"
      className="flex min-h-9 items-center gap-2 border-b border-border bg-muted/50 px-4 text-sm text-muted-foreground"
    >
      <StatusDot tone={uncertain ? 'danger' : 'pending'} />
      <span>{message}</span>
      <Link
        to="/settings/agent-defaults#providers"
        className="ml-auto shrink-0 font-medium text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Configure providers
      </Link>
    </div>
  )
}
