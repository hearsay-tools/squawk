import { useQuery } from '@tanstack/react-query'
import type { RunSummary } from '@open-mercato/cezar-api-client'

import { getRuns } from './client'
import { projectAddress } from './run-address'

/**
 * One project's run list by EXPLICIT id — the sidebar's per-group task lists (step 3.3), which
 * must read projects the mounted scope cannot reach. Keyed `[projectId, 'runs', 'list']`: for
 * the ACTIVE project that is the very entry `useRuns()` fills and the stream patches, so the
 * two views share one cache; for any other project it is that project's own entry, kept fresh
 * by refetch-on-expand rather than by the stream (the stream filter applies only the active
 * scope's events). `enabled: false` parks the fetch — a COLLAPSED group costs one registry
 * row, never a runs request (spec, "40 registered projects" row) — while still reading any
 * cached answer, which is what lets a collapsed group keep its attention badge.
 *
 * `boot: true` aliases the key scope to `'default'`: the boot project's main view and the SSE
 * patcher keep its list there, so reading any other entry would freeze it. The fetch still goes
 * to `/api/p/<bootId>/runs` (route parity). If health or the registry names the boot project
 * after the list answered under its id key, that list stays as placeholder data until `'default'`
 * answers, so the sidebar rows never unmount (hearsay-tools/squawk#3048). Other moves start empty.
 */
export function useProjectRuns<T = RunSummary[]>(projectId: string, enabled = true, boot = false, select?: (runs: RunSummary[]) => T) {
  return useQuery<RunSummary[], Error, T>({
    queryKey: [projectAddress({ projectId, boot }).cacheScope, 'runs', 'list'] as const,
    queryFn: ({ signal }) => getRuns(projectAddress({ projectId, boot }), { signal }),
    enabled,
    ...(select ? { select } : {}),
    placeholderData: (previous, previousQuery) => (boot && previousQuery?.queryKey[0] === projectId ? previous : undefined),
  })
}

