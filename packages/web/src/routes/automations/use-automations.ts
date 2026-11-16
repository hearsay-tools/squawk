import { onLiveReconcile } from '@/api/live-coordinator'
import { useCallback, useEffect, useState } from 'react'
import type { AutomationsResponse } from '@open-mercato/cezar-api-client'

import { onWorkspaceEvent } from '@/api/global-events'
import { getAutomations } from '@/api/client'
import { useAutomationsAvailable } from '@/lib/capabilities'
import { useActiveProjectId } from '@/lib/project-router'

/**
 * The automations list for the project on screen: one fetch once health says the capability is
 * on, refreshed by the workspace `automation-change` signal and by `refresh()`.
 *
 * Waits for health rather than firing optimistically: a fetch made before the answer arrives
 * would 409 on a gated server and paint an error over the disabled state. The effect depends on
 * one boolean, not `health.data`, so a health refetch does not re-request the list.
 */
/** `archived`: `only` for the list's Archived filter; `include` where one schedule is looked up by id. */
export function useAutomations(archived?: 'include' | 'only'): {
  data: AutomationsResponse | undefined
  error: string
  refresh: () => Promise<void>
} {
  const projectId = useActiveProjectId()
  const available = useAutomationsAvailable()
  const [data, setData] = useState<AutomationsResponse>()
  const [error, setError] = useState('')
  const refresh = useCallback(
    (signal?: AbortSignal) => getAutomations({ signal, ...(archived ? { archived } : {}) }).then((next) => { if (signal?.aborted) return; setData(next); setError('') }).catch((cause) => { if (!signal?.aborted) setError(String(cause)) }),
    [archived],
  )
  useEffect(() => { if (available) void refresh() }, [available, refresh])
  useEffect(() => onLiveReconcile(async signal => { if (available) await refresh(signal) }), [available, refresh])
  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name !== 'automation-change') return
    const changed = payload as { project?: unknown }
    if (typeof changed.project === 'string' && (projectId === null || changed.project === projectId)) void refresh()
  }), [projectId, refresh])
  return { data, error, refresh }
}
