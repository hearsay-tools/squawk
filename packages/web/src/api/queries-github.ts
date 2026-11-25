import { useCallback, useEffect, useMemo } from 'react'
import { useInfiniteQuery, useQueries, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import { REFERENCE_STATUS_MAX } from '@open-mercato/cezar-api-client/contract/github'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { GithubData, GithubRefStatusData, ReferenceStatus } from '@open-mercato/cezar-api-client'
import { isCockpitE2e } from '@/lib/e2e-mode'
import { liveRefetchInterval } from '@/lib/live-refetch'
import { subscribeLiveRead, useLiveRead } from './live-reads'
import { useProjectScope } from './project-scope-context'
import {
  collectReferenceStatusEntries,
  refStatusKey,
  rememberStatus,
  rememberedConflicts,
  rememberedStatuses,
  type ReferenceStatusEntry,
  type ReferenceStatusLookup,
  type ReferenceStatusRequest,
} from './reference-status-memory'
import {
  flattenGithubPages,
  GITHUB_PAGE_SIZE,
  nextGithubPageParam,
  reconcileGithubHead,
  type GithubPageParam,
} from './github-pages'
import { queryKeys } from './query-keys'
import { useHealth } from './queries-workspace'
import {
  ApiError,
  getGithub,
  getGithubChecks,
  getGithubCommentCounts,
  getGithubComments,
  getGithubItem,
  getGithubPrChanges,
  getGithubProjects,
  getGithubRefStatus,
  getGithubSearch,
} from './client'

/** GitHub edits produce no Squawk events (#152). The owner-approved polling exception
 * refreshes mounted, foreground lists every minute; unmounted queries have no timer.
 * Revisit/focus after a minute also refetches. Automatic reads retain the server's 60 s
 * cache, so an upstream edit appears within 120 s plus request time while online/visible.
 * Explicit Refresh remains the only list-cache bypass. */
export function useGithub(params: { limit?: number | undefined } = {}, enabled = true) {
  const client = useQueryClient()
  const key = queryKeys.github(params)
  useLiveRead(`/api/v1/p/${queryScope()}/github${params.limit === undefined ? '' : `?limit=${params.limit}`}`, key, liveRefetchInterval(enabled ? 60_000 : false))
  const list = useQuery({
    queryKey: queryKeys.github(params),
    queryFn: ({ signal }) => getGithub({ limit: params.limit }, { signal }),
    enabled,
    staleTime: 60_000,
    refetchInterval: false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  })
  const generation = list.data?.projectsGeneration
  const metadata = useQuery({
    queryKey: [...key, 'projects', generation],
    queryFn: ({ signal }) => getGithubProjects(generation!, { signal }),
    enabled: enabled && list.data?.projectsState === 'refreshing' && !!generation,
    staleTime: Infinity,
    retry: false,
  })
  useEffect(() => {
    if (!generation || (!metadata.data && !metadata.error)) return
    client.setQueryData<typeof list.data>(key, current => {
      if (!current || current.projectsGeneration !== generation || current.projectsState !== 'refreshing') return current
      const result = metadata.data
      if (result?.generation && result.generation !== generation) return current
      return result?.state === 'ready' ? {
        ...current, projectsState: 'ready', projects: result.projects,
        issues: current.issues.map(issue => ({ ...issue, projectIds: result.membership?.[issue.number] ?? [] })),
      } : {
        ...current, projectsState: 'unavailable',
        projectsReason: result?.reason ?? 'Project boards unavailable. Refresh to try again.',
      }
    })
  }, [client, generation, metadata.data, metadata.error, key])
  return list
}

/**
 * The GitHub list for an EXPLICIT project scope — the sidebar's and the filter screen's read of
 * the very cache entry `useGithub` fills for the routed view.
 */
export function useProjectGithub(scope: string, params: { limit?: number | undefined } = {}, enabled = true) {
  return useQuery({
    queryKey: [scope, 'github', params.limit ?? null] as const,
    queryFn: ({ signal }) => getGithub({ limit: params.limit, projectId: scope }, { signal }),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}

type GithubPages = InfiniteData<GithubData, GithubPageParam>

/** A later page GitHub could not serve. The server degrades in the payload (`available: false`,
 *  HTTP 200), which as a page would end the list with no way on: thrown instead, it surfaces as
 *  the failed page whose Retry asks for the same cursor again. */
class GithubPageUnavailableError extends Error {}

/** The options both readers of one paged list share, so either can start the query. */
function githubPagesOptions(key: readonly unknown[], pageSize: number, projectId?: string) {
  return {
    queryKey: key,
    initialPageParam: {} as GithubPageParam,
    queryFn: async ({ pageParam, signal }: { pageParam: GithubPageParam; signal: AbortSignal }) => {
      const page = await getGithub({ limit: pageSize, ...pageParam, ...(projectId ? { projectId } : {}) }, { signal })
      // Page 1 keeps its payload: the tab's own unavailable state explains it.
      if (!page.available && Object.keys(pageParam).length > 0) throw new GithubPageUnavailableError(page.reason ?? 'GitHub is unavailable.')
      return page
    },
    getNextPageParam: (last: GithubData) => nextGithubPageParam(last),
    // GitHub's own answer is not retried behind the user's back: Retry is theirs to press.
    retry: (failureCount: number, error: Error) => !(error instanceof GithubPageUnavailableError)
      && !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failureCount < 1,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  }
}

/**
 * The GitHub tab's list, a page at a time (hearsay-tools/cezarion#1183). `pages` is the infinite
 * query (`fetchNextPage`, `hasNextPage`, errors); `data` flattens every loaded page into the
 * single-list shape the tab rendered before paging.
 */
export function useGithubPages(pageSize = GITHUB_PAGE_SIZE, enabled = true) {
  const client = useQueryClient()
  const key = queryKeys.githubPages(pageSize)
  const headKey = queryKeys.githubPagesHead(pageSize)
  useLiveRead(`/api/v1/p/${queryScope()}/github?limit=${pageSize}`, headKey, liveRefetchInterval(enabled ? 60_000 : false))
  const pages = useInfiniteQuery({ ...githubPagesOptions(key, pageSize), enabled, refetchInterval: false, refetchIntervalInBackground: false })
  // Observes what the live read writes; never fetches on its own.
  const head = useQuery({
    queryKey: headKey,
    queryFn: ({ signal }) => getGithub({ limit: pageSize }, { signal }),
    enabled: false,
    staleTime: Infinity,
  })
  const { refetch } = pages
  useEffect(() => {
    if (!head.data) return
    const current = client.getQueryData<GithubPages>(key)
    if (!current || current.pages.length === 0) return
    const next = reconcileGithubHead(current.pages, head.data)
    if (next === 'refetch') void refetch()
    else client.setQueryData<GithubPages>(key, { ...current, pages: next })
    // `head.dataUpdatedAt` alone decides when a new head arrived.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, head.dataUpdatedAt, refetch])

  const refreshing = (pages.data?.pages ?? []).flatMap((page) =>
    page.projectsState === 'refreshing' && page.projectsGeneration ? [page.projectsGeneration] : [])
  const metadata = useQueries({
    queries: refreshing.map((generation) => ({
      queryKey: [...key, 'projects', generation],
      queryFn: ({ signal }: { signal: AbortSignal }) => getGithubProjects(generation, { signal }),
      enabled,
      staleTime: Infinity,
      retry: false,
    })),
  })
  const settled = metadata.map((result, index) => (result.data || result.error ? refreshing[index] : '')).join(',')
  useEffect(() => {
    metadata.forEach((result, index) => {
      const generation = refreshing[index]
      if (!generation || (!result.data && !result.error)) return
      client.setQueryData<GithubPages>(key, (current) => {
        if (!current) return current
        let changed = false
        const next = current.pages.map((page) => {
          if (page.projectsGeneration !== generation || page.projectsState !== 'refreshing') return page
          const answer = result.data
          if (answer?.generation && answer.generation !== generation) return page
          changed = true
          return answer?.state === 'ready' ? {
            ...page, projectsState: 'ready' as const, projects: answer.projects,
            issues: page.issues.map((issue) => ({ ...issue, projectIds: answer.membership?.[issue.number] ?? [] })),
          } : {
            ...page, projectsState: 'unavailable' as const,
            projectsReason: answer?.reason ?? 'Project boards unavailable. Refresh to try again.',
          }
        })
        return changed ? { ...current, pages: next } : current
      })
    })
    // `settled` names exactly the generations with an answer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, settled])

  const data = useMemo(() => flattenGithubPages(pages.data?.pages ?? []), [pages.data])
  return { pages, data }
}

/**
 * The paged list for an EXPLICIT project scope: the sidebar's and the filter screen's read of the
 * cache entry `useGithubPages` fills for the routed view.
 */
export function useProjectGithubPages(scope: string, pageSize = GITHUB_PAGE_SIZE, enabled = true) {
  const pages = useInfiniteQuery({ ...githubPagesOptions([scope, 'github', 'pages', pageSize] as const, pageSize, scope), enabled })
  const data = useMemo(() => flattenGithubPages(pages.data?.pages ?? []), [pages.data])
  return { pages, data }
}

/**
 * Deferred comment counts (hearsay-tools/cezarion#1183), one request per group of row numbers.
 */
export function useGithubCommentCounts(kind: 'issue' | 'pr', groups: readonly (readonly number[])[], enabled = true): Record<number, number> {
  const results = useQueries({
    queries: groups.filter((numbers) => numbers.length > 0).map((numbers) => ({
      queryKey: queryKeys.githubCommentCounts(kind, numbers),
      queryFn: ({ signal }: { signal: AbortSignal }) => getGithubCommentCounts(kind, numbers, {}, { signal }),
      enabled,
      staleTime: 60_000,
    })),
  })
  const signature = results.map((result) => result.dataUpdatedAt).join(',')
  return useMemo(() => {
    const counts: Record<number, number> = {}
    for (const result of results) if (result.data?.available) Object.assign(counts, result.data.counts)
    return counts
    // `signature` changes exactly when an answer does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
}

/** `useGithubSearch` for an explicit scope (see `useProjectGithub`); shares its cache entry. */
export function useProjectGithubSearch(scope: string, kind: 'issue' | 'pr', query: string, enabled = true) {
  return useQuery({
    queryKey: [scope, 'github', 'search', kind, query] as const,
    queryFn: ({ signal }) => getGithubSearch(kind, query, { projectId: scope }, { signal }),
    enabled: enabled && query.trim() !== '',
    staleTime: 60_000,
  })
}

/** Lazy PR checks glyphs (`/api/github/checks`, #664). */
export function useGithubChecks(prNumbers: number[], enabled = true) {
  return useQuery({
    queryKey: queryKeys.githubChecks(prNumbers),
    queryFn: ({ signal }) => getGithubChecks(prNumbers, { signal }),
    enabled: enabled && prNumbers.length > 0,
    staleTime: 60_000,
  })
}

/** Cross-state search (`/api/github/search`, #730). */
export function useGithubSearch(kind: 'issue' | 'pr', query: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.githubSearch(kind, query),
    queryFn: ({ signal }) => getGithubSearch(kind, query, {}, { signal }),
    enabled: enabled && query.trim() !== '',
    staleTime: 60_000,
  })
}

const REF_STATUS_MAX = REFERENCE_STATUS_MAX

function cappedNumbers(numbers: Iterable<number>): number[] {
  return [...numbers]
    .sort((a, b) => b - a)
    .slice(0, REF_STATUS_MAX)
    .sort((a, b) => a - b)
}

/**
 * The project a surface's references belong to, named the way the REST of the cockpit names it.
 */
export function useReferenceProjectId(): string | undefined {
  const scope = useProjectScope()
  const health = useHealth()
  return scope.projectId ?? health.data?.bootProject
}

/**
 * Adopt statuses that arrived with something else — today, the cross-project run index, which
 * ships whatever the server already had cached for the references its rows carry.
 */
export function rememberReferenceStatuses(
  byProject: Record<string, { prs: Record<number, ReferenceStatus>; issues: Record<number, ReferenceStatus> }>,
): void {
  for (const [projectId, buckets] of Object.entries(byProject)) {
    for (const [number, status] of Object.entries(buckets.prs)) {
      rememberStatus(refStatusKey({ projectId, kind: 'PR', number: Number(number) }), status)
    }
    for (const [number, status] of Object.entries(buckets.issues)) {
      rememberStatus(refStatusKey({ projectId, kind: 'Issue', number: Number(number) }), status)
    }
  }
}

const REF_STATUS_FALLBACK_MS = 5 * 60_000

export function refStatusRecheckAfter(data: GithubRefStatusData | undefined): number | null {
  if (!data) return REF_STATUS_FALLBACK_MS
  return data.recheckAfterMs
}

/**
 * Status for every PR/issue chip a surface is painting, in as few requests as there are projects
 * on screen.
 */
export function useReferenceStatuses(
  refs: readonly ReferenceStatusRequest[],
  enabled = true,
): ReferenceStatusLookup {
  const signature = refs
    .map(refStatusKey)
    .sort()
    .join('|')
  const groups = useMemo(() => {
    const byProject = new Map<string, { prs: Set<number>; issues: Set<number> }>()
    for (const ref of refs) {
      const bucket = byProject.get(ref.projectId) ?? { prs: new Set<number>(), issues: new Set<number>() }
      bucket[ref.kind === 'PR' ? 'prs' : 'issues'].add(ref.number)
      byProject.set(ref.projectId, bucket)
    }
    return [...byProject.entries()].map(([projectId, bucket]) => ({
      projectId,
      prs: cappedNumbers(bucket.prs),
      issues: cappedNumbers(bucket.issues),
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` IS the content of `refs`
  }, [signature])

  const results = useQueries({
    queries: groups.map((group) => ({
      queryKey: queryKeys.githubRefStatus(group.projectId, group.prs, group.issues),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getGithubRefStatus(group.projectId, { prs: group.prs, issues: group.issues }, { signal }),
      enabled: enabled && group.prs.length + group.issues.length > 0,
      staleTime: (query: { state: { data?: GithubRefStatusData | undefined } }) =>
        refStatusRecheckAfter(query.state.data) ?? Infinity,
      refetchInterval: false,
      refetchOnWindowFocus: true,
    })),
  })

  const referenceClient = useQueryClient()
  const readsSignature = JSON.stringify(groups.map((group, index) => ({ ...group, interval: refStatusRecheckAfter(results[index]?.data) ?? false })))
  useEffect(() => {
    if (!enabled || isCockpitE2e()) return
    let active = true
    const demands = JSON.parse(readsSignature) as Array<{ projectId: string; prs: number[]; issues: number[]; interval: number | false }>
    const releases = demands.filter(group => group.interval !== false).map(group => {
      const params = new URLSearchParams()
      if (group.prs.length) params.set('prs', group.prs.join(','))
      if (group.issues.length) params.set('issues', group.issues.join(','))
      const key = queryKeys.githubRefStatus(group.projectId, group.prs, group.issues)
      return subscribeLiveRead({ path: `/api/v1/p/${group.projectId}/github/ref-status?${params}`, intervalMs: group.interval as number }, (value, error) => {
        if (error) return
        // A document-local refetch must not overwrite the newer shared snapshot.
        void referenceClient.cancelQueries({ queryKey: key, exact: true }).then(() => {
          if (active) referenceClient.setQueryData(key, value)
        })
      })
    })
    return () => { active = false; for (const release of releases) release() }
  }, [enabled, readsSignature, referenceClient])

  const byRef = useMemo(() => {
    return collectReferenceStatusEntries(groups, results)
    // `results` is a fresh array identity every render; its DATA is what the map is built from.
  }, [groups, results.map((result) => `${result.dataUpdatedAt}:${result.status}`).join(',')])

  return useCallback(
    (ref: ReferenceStatusRequest): ReferenceStatusEntry => {
      const key = refStatusKey(ref)
      const current = byRef.get(key)
      if (current) return current
      const remembered = rememberedStatuses.get(key)
      return {
        state: 'idle',
        ...(remembered ? { status: remembered } : {}),
        ...(rememberedConflicts.has(key) ? { conflicting: true } : {}),
      }
    },
    [byRef],
  )
}

/** The comment thread for one issue/PR (`/api/github/comments/…`, #499). */
export function useGithubComments(kind: 'issue' | 'pr', number: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.githubComments(kind, number),
    queryFn: ({ signal }) => getGithubComments(kind, number, {}, { signal }),
    enabled,
    staleTime: 60_000,
  })
}

/** One issue/PR for a task's item tab (#692). */
export function useGithubItem(kind: 'issue' | 'pr', number: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.githubItem(kind, number),
    queryFn: ({ signal }) => getGithubItem(kind, number, {}, { signal }),
    enabled,
    staleTime: 60_000,
  })
}

export function useGithubPrChanges(number: number | undefined) {
  return useQuery({
    queryKey: queryKeys.githubPrChanges(number ?? 0),
    queryFn: ({ signal }) => getGithubPrChanges(number as number, {}, { signal }),
    enabled: number !== undefined,
    staleTime: 60_000,
    retry: false,
  })
}
