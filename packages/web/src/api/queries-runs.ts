import { useCallback, useMemo } from 'react'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type MutateOptions,
  type UseQueryResult,
} from '@tanstack/react-query'
import { ARCHIVED_RUNS_PAGE_MAX } from '@open-mercato/cezar-api-client/contract/run-limits'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type {
  MessageInput,
  NotifyRunInput,
  PatchRunInput,
  RunRecord,
  RunsIndexResponse,
} from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'
import { liveRefetchInterval } from '@/lib/live-refetch'
import { projectAddress, runAddress, type ProjectAddress, type RunAddress } from './run-address'
import type { ReadPatch } from './run-cache'
import { useRunCacheWriter } from './use-run-cache-writer'
import { useLiveRead } from './live-reads'
import { mergeRunsIndexRead, RUNS_INDEX_BACKSTOP_MS, runsIndexSync } from './runs-index-sync'
import { destroyWorker } from './worker-destroy'
import { queryKeys, workspaceQueryKeys } from './query-keys'
import {
  ApiError,
  continueRun,
  editQueuedMessage,
  getArchivedRuns,
  getArtifact,
  getArtifactMetadata,
  getArtifacts,
  getAutomations,
  getFileLink,
  getOpenTargets,
  getRun,
  getRunChanges,
  getRunCommit,
  getRunCommits,
  getRunDiff,
  getRunFile,
  getRunHandoff,
  getRunRelationships,
  getRuns,
  getRunsIndex,
  notifyRun,
  patchRun,
  pinRun,
  removeQueuedMessage,
  searchRuns,
  sendMessage,
  setRunRead,
  type ContinueOptions,
} from './client'

/** The local "Open in…" targets (#open-in). Machine-level and stable, so it caches broadly;
 *  empty in hosted mode. */
export function useOpenTargets() {
  return useQuery({
    queryKey: queryKeys.openTargets,
    queryFn: ({ signal }) => getOpenTargets({ signal }),
    staleTime: 5 * 60_000,
  })
}

/** The authoritative run list. */
export function useRuns() {
  return useQuery({
    queryKey: queryKeys.runs.list(),
    queryFn: ({ signal }) => getRuns(projectAddress(), { signal }),
  })
}

/** The archived runs past the run list's window, `ARCHIVED_RUNS_PAGE_MAX` at a time (#864): the
 *  newest pages, or the matches for `q`. Only while `enabled` — the Archived tab, when the list's
 *  window is full or there is something to search for. */
export function useArchivedRuns(q: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: queryKeys.runs.archived(q),
    enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => getArchivedRuns({ before: pageParam, limit: ARCHIVED_RUNS_PAGE_MAX, q }, { signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // The previous search's pages stay on screen while the next ones load — but only within one
    // project: another project's archived tasks must never show under this one (#864 review).
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[0] === queryScope() ? previous : undefined),
  })
}

/** The shortest query `GET /workspace/runs-search` accepts. */
export const MIN_RUNS_SEARCH_LENGTH = 2

/**
 * Every project's runs matching `q`, at any age (#864) — what ⌘K adds to the runs it already
 * holds once there is something typed. Off below `MIN_RUNS_SEARCH_LENGTH` characters, which the
 * server refuses; the previous answer stays on screen while the next one loads.
 */
export function useRunsSearch(q: string) {
  const query = q.trim()
  return useQuery({
    queryKey: workspaceQueryKeys.runsSearch(query),
    queryFn: ({ signal }) => searchRuns(query, { signal }),
    enabled: query.length >= MIN_RUNS_SEARCH_LENGTH,
    placeholderData: keepPreviousData,
    staleTime: 10_000,
  })
}

/**
 * Every registered project's recent tasks, slim: ⌘K, the sidebar signals and the global Tasks
 * page. ONE request for the whole registry; N `useProjectRuns` calls would ship full records.
 */
export function useRunsIndex<T>(enabled: boolean, refetchIntervalMs: number | undefined, select: (index: RunsIndexResponse) => T): UseQueryResult<T>
export function useRunsIndex(enabled?: boolean, refetchIntervalMs?: number): UseQueryResult<RunsIndexResponse>
export function useRunsIndex<T = RunsIndexResponse>(enabled = true, refetchIntervalMs: number = RUNS_INDEX_BACKSTOP_MS, select?: (index: RunsIndexResponse) => T) {
  const sync = runsIndexSync(useQueryClient())
  useLiveRead('/api/v1/workspace/runs-index', workspaceQueryKeys.runsIndex, liveRefetchInterval(enabled ? refetchIntervalMs : false), mergeRunsIndexRead)
  return useQuery<RunsIndexResponse, Error, T>({
    queryKey: workspaceQueryKeys.runsIndex,
    queryFn: ({ signal }) => getRunsIndex({ signal }).then(sync.merge),
    enabled,
    ...(select ? { select } : {}),
    staleTime: 30_000,
    refetchInterval: false,
  })
}

/** Clean up one settled worker (#816). Settles either way by refetching its parent's
 *  relationships, so a freed slot or an incomplete cleanup shows without waiting for SSE. */
export function useDestroyWorker(parentRunId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ workerId, discardWork = false }: { workerId: string; discardWork?: boolean }) => destroyWorker(workerId, discardWork),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.relationships(parentRunId) }),
  })
}

/** Complete relationship context, refreshed through the existing global run stream. */
export function useRunRelationships(runId: string, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: queryKeys.runs.relationships(runId),
    queryFn: ({ signal }) => getRunRelationships(runId, { signal }),
    enabled: options.enabled ?? true,
  })
}

/** One run, authoritative. `id` may be absent while a route param is still unresolved. */
export function useRun(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.detail(id ?? ''),
    queryFn: ({ signal }) => getRun(runAddress(id as string), { signal }),
    enabled: Boolean(id),
  })
}

/**
 * One run of a NAMED project — what a surface outside `/p/:projectId` has to use.
 */
export function useProjectRun(projectId: string | undefined, id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [projectId ?? 'default', 'runs', 'detail', id ?? ''] as const,
    queryFn: ({ signal }) => getRun(runAddress(id as string, { projectId: projectId as string }), { signal }),
    enabled: enabled && Boolean(projectId) && Boolean(id),
  })
}

export function useRunDiff(id: string | undefined, projectId?: string) {
  return useQuery({
    queryKey: projectId ? [projectId, 'runs', 'diff', id ?? ''] as const : queryKeys.runs.diff(id ?? ''),
    queryFn: ({ signal }) => getRunDiff(id as string, { signal, ...(projectId ? { projectId } : {}) }),
    enabled: Boolean(id),
  })
}

/** The structured session diff behind the Changes tab (R5). A 409 (for example, a reclaimed
 *  worktree whose directory is unavailable) is a real answer, not a network hiccup — retrying
 *  cannot change it, so retries are off and the view renders the server's own reason. */
export function useRunChanges(id: string | undefined, live = false) {
  useLiveRead(id ? `/api/v1/p/${queryScope()}/runs/${encodeURIComponent(id)}/changes` : undefined, queryKeys.runs.changes(id ?? ''), liveRefetchInterval(live ? 4000 : false))
  return useQuery({
    queryKey: queryKeys.runs.changes(id ?? ''),
    queryFn: ({ signal }) => getRunChanges(id as string, { signal }),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
}

/** Cached Files listing/preview per (run, path): '' is the root, undefined is no selection.
 *  Like /changes, a 409 (no worktree) cannot change through retries, so retries are off. */
export function useRunFile(id: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.file(id ?? '', path ?? ''),
    queryFn: ({ signal }) => getRunFile(id as string, path as string, { signal }),
    enabled: Boolean(id) && path !== undefined,
    retry: false,
  })
}

export function useFileLink(id: string, path: string | null) {
  return useQuery({ queryKey: [queryScope(), 'runs', 'file-link', id, path], queryFn: ({ signal }) => getFileLink(id, path!, { signal }), enabled: path !== null, retry: false })
}

export function useArtifact(id: string, artifactId: string | null) {
  return useQuery({ queryKey: [queryScope(), 'runs', 'artifact', id, artifactId], queryFn: ({ signal }) => getArtifact(id, artifactId!, { signal }), enabled: artifactId !== null, retry: false })
}

export function useArtifactMetadata(runId: string, artifactId: string | null) {
  return useQuery({ queryKey: [queryScope(), 'runs', 'artifact-metadata', runId, artifactId], queryFn: ({ signal }) => getArtifactMetadata(runId, artifactId!, { signal }), enabled: artifactId !== null, retry: false })
}

export function useArtifacts(id: string) {
  return useQuery({ queryKey: [queryScope(), 'runs', 'artifacts', id], queryFn: ({ signal }) => getArtifacts(id, { signal }), retry: false, staleTime: 0, refetchOnWindowFocus: true })
}

/** A run's commit list (Commits tab). Polls while active so new commits appear as the agent
 *  works. A 409 from an unavailable backing directory is a real answer retries can't change. */
export function useRunCommits(id: string | undefined, live = false) {
  useLiveRead(id ? `/api/v1/p/${queryScope()}/runs/${encodeURIComponent(id)}/commits` : undefined, queryKeys.runs.commits(id ?? ''), liveRefetchInterval(live ? 5000 : false))
  return useQuery({
    queryKey: queryKeys.runs.commits(id ?? ''),
    queryFn: ({ signal }) => getRunCommits(id as string, { signal }),
    enabled: Boolean(id),
    retry: false,
    refetchInterval: false,
  })
}

/** One of a run's commits, structured like the Changes tab. */
export function useRunCommit(id: string | undefined, sha: string | undefined) {
  return useQuery({
    queryKey: queryKeys.runs.commit(id ?? '', sha ?? ''),
    queryFn: ({ signal }) => getRunCommit(id as string, sha as string, { signal }),
    enabled: Boolean(id) && Boolean(sha),
    retry: false,
  })
}

/** The handoff journal behind the header's Notes panel. `enabled` gates the fetch on the panel
 *  actually being open — notes are read on demand, not on every thread visit. */
export function useRunHandoff(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.runs.handoff(id ?? ''),
    queryFn: ({ signal }) => getRunHandoff(runAddress(id as string), { signal }),
    enabled: Boolean(id) && enabled,
  })
}

/** A Tasks row's inline preview (hearsay-tools/cezarion#1616): the same journal, read when the row
 *  opens. `projectId` names another project's run (All tasks); absent reads the active scope, under
 *  the Notes panel's own key so the two share one fetch. */
export function useTaskPreviewHandoff(projectId: string | undefined, id: string, enabled: boolean) {
  return useQuery({
    queryKey: projectId === undefined ? queryKeys.runs.handoff(id) : [projectId, 'runs', 'handoff', id] as const,
    queryFn: ({ signal }) => getRunHandoff(runAddress(id, { projectId }), { signal }),
    enabled,
    staleTime: 15_000,
  })
}

/**
 * Automation names for the Tasks pages' origin line (hearsay-tools/cezarion#1616), one read per
 * project that shows automation tasks, archived definitions included.
 */
export function useAutomationNames(projectIds: readonly (string | undefined)[], enabled: boolean) {
  const unique = [...new Set(projectIds)]
  const results = useQueries({
    queries: unique.map((projectId) => ({
      queryKey: [projectId ?? queryScope(), 'automations', 'names'] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getAutomations({ signal, archived: 'include', ...(projectId === undefined ? {} : { projectId }) }),
      enabled,
      staleTime: 60_000,
      retry: false,
    })),
  })
  // One stable lookup per set of answers, so callers can memoize on it.
  const answers = results.map((result) => result.data)
  const version = JSON.stringify([unique, results.map((result) => result.dataUpdatedAt)])
  return useMemo(() => {
    const names = new Map<string, string>()
    answers.forEach((data, index) => {
      if (!data?.available) return
      for (const automation of data.automations) names.set(JSON.stringify([unique[index] ?? null, automation.id]), automation.name)
    })
    return (projectId: string | undefined, automationId: string): string | undefined =>
      names.get(JSON.stringify([projectId ?? null, automationId]))
    // `version` changes exactly when an answer or the project set does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])
}

/**
 * Hand a task to the project webhook, send it another note, or stop notifying it (#589). The
 * record comes back with `notify` flipped and also rides the `run` SSE; the invalidation covers
 * a tab whose stream is between reconnects.
 */
export function useNotifyRun(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: NotifyRunInput) => notifyRun(id, input),
    retry: false,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}

/** Rename a run (#389): `PATCH /api/runs/:id`. Invalidates `runs.*` so the list and the detail
 *  view refetch the authoritative record. The run header's inline title edit sits on this. */
export function usePatchRun(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: PatchRunInput) => patchRun(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}

/**
 * Mark one run read (#unread-done-items): `POST /api/runs/:id/read`.
 */
export function useMarkRunSeen(address?: ProjectAddress) {
  const writer = useRunCacheWriter()
  const projectId = address?.projectId
  const cacheScope = address?.cacheScope
  type Receipt = RunAddress & { id: string }
  type Snapshot = ReadPatch
  const mutation = useMutation<RunRecord, Error, Receipt, Snapshot>({
    mutationFn: (address) => setRunRead(address, true),
    onMutate: (address) => writer.patchRead(address, true),
    onError: (_error, _address, snapshot) => snapshot?.rollback(),
    onSuccess: (updated, _address, snapshot) => snapshot?.settle(updated),
  })
  const capture = useCallback((id: string): Receipt => {
    return { ...runAddress(id, { projectId, cacheScope }), id }
  }, [projectId, cacheScope])
  // Preserve the existing string-variable API, including per-call callbacks and variables.
  type Options = MutateOptions<RunRecord, Error, string, Snapshot>
  const callbacks = useCallback((options?: Options): MutateOptions<RunRecord, Error, Receipt, Snapshot> => ({
    onSuccess: (data, receipt, snapshot, context) => options?.onSuccess?.(data, receipt.id, snapshot, context),
    onError: (error, receipt, snapshot, context) => options?.onError?.(error, receipt.id, snapshot, context),
    onSettled: (data, error, receipt, snapshot, context) => options?.onSettled?.(data, error, receipt.id, snapshot, context),
  }), [])
  const { mutate, mutateAsync } = mutation
  const mutateSeen = useCallback((id: string, options?: Options) => mutate(capture(id), callbacks(options)), [mutate, capture, callbacks])
  const mutateSeenAsync = useCallback((id: string, options?: Options) => mutateAsync(capture(id), callbacks(options)), [mutateAsync, capture, callbacks])
  return {
    ...mutation,
    variables: mutation.variables?.id,
    mutate: mutateSeen,
    mutateAsync: mutateSeenAsync,
  }
}

/**
 * Put one finished run back to unread (#775): `POST /api/runs/:id/unread`.
 */
export function useMarkRunUnseen() {
  const writer = useRunCacheWriter()
  return useMutation({
    mutationFn: (id: string) => setRunRead(runAddress(id), false),
    // Preserve late scope reads: this hook historically follows navigation between callbacks.
    onMutate: (id: string) => writer.patchRead(() => runAddress(id), false),
    onError: (_error, _id, context) => context?.rollback(),
    onSuccess: (updated, _id, context) => context?.settle(updated),
  })
}

/**
 * Pin one task to the top of its project's list, or unpin it (#935) — `POST /api/v1/runs/:id/pin`.
 */
export function usePinRun(address?: ProjectAddress) {
  const writer = useRunCacheWriter()
  return useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) =>
      pinRun(runAddress(id, address), pinned),
    onError: (error: Error) => toast(`Could not update pin. ${error.message} Please retry.`, { tone: 'danger' }),
    // Capture before the request: navigation during the round trip must not retarget invalidation.
    onMutate: () => address ?? projectAddress(),
    // Hierarchical keys: this covers the list AND the open thread's own record.
    onSuccess: (_updated, _variables, context) =>
      writer.invalidateAfter('runs', context),
  })
}

/** Deliver a reply into a live session (`POST /api/runs/:id/messages`). */
export function useSendMessage(id: string, projectId?: string) {
  const writer = useRunCacheWriter()
  return useMutation({
    mutationFn: (message: MessageInput) => sendMessage(runAddress(id, { projectId }), message),
    onMutate: () => projectAddress({ projectId }),
    onSuccess: (_result, _message, address) => writer.invalidateAfter('send', address),
    onError: (error, _message, address) => {
      if (error instanceof ApiError && error.status === 409 && address) {
        void writer.invalidateAfter('send', address)
      }
    },
  })
}

/** Reopen a closed run's last agent session (`POST /api/runs/:id/continue`), starting it on an
 *  opening prompt. */
export function useContinueRun(id: string, projectId?: string) {
  const writer = useRunCacheWriter()
  return useMutation({
    mutationFn: (opts: ContinueOptions = {}) => continueRun(runAddress(id, { projectId }), opts),
    onMutate: () => projectAddress({ projectId }),
    onSuccess: (_result, _opts, address) => writer.invalidateAfter('continue', address),
  })
}

/** Edit a message stacked on a queued run (`PATCH /api/runs/:id/queued-messages/:msgId`, #472). */
export function useEditQueuedMessage(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ msgId, message }: { msgId: string; message: MessageInput }) =>
      editQueuedMessage(id, msgId, message),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}

/** Remove a message stacked on a queued run (`DELETE /api/runs/:id/queued-messages/:msgId`). */
export function useRemoveQueuedMessage(id: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (msgId: string) => removeQueuedMessage(id, msgId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
  })
}
