import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { normalizeSidebarLimits } from '@open-mercato/cezar-api-client/contract/workspace'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import type { SessionContextRole, SetAgentConfigInput, SetSessionContextInput } from '@open-mercato/cezar-api-client'
import { projectAddress } from './run-address'
import { queryKeys } from './query-keys'
import {
  getAgentConfig,
  getAgentConfigFile,
  getSessionContext,
  postSessionContextPreview,
  putSessionContext,
  getConfig,
  getRepo,
  getRepoBranches,
  getRepoChanges,
  getRepoCommit,
  getUiState,
  getWorkflows,
  getWorktrees,
  putAgentConfigFile,
} from './client'

export function useWorkflows() {
  return useQuery({
    queryKey: queryKeys.workflows,
    queryFn: ({ signal }) => getWorkflows({ signal }),
  })
}

export function useRepo(projectId?: string) {
  return useQuery({
    queryKey: projectId ? ([projectId, 'repo'] as const) : queryKeys.repo,
    queryFn: ({ signal }) => getRepo({ signal }, projectId),
  })
}

/** `useRepo` with an EXPLICIT scope, for the Git sidebar above the `ProjectScopeProvider`. The key
 *  is `queryKeys.repo`'s shape, so the sidebar and the routed view share one cache entry and every
 *  `queryKeys.repo` invalidation reaches both. */
export function useProjectRepo(scope: string) {
  return useQuery({
    queryKey: [scope, 'repo'] as const,
    queryFn: ({ signal }) => getRepo({ signal }, scope),
  })
}

/** The classified branch list (`GET /repo/branches`, issue 08): Not landed, Cleanup's branch card
 *  and All branches' class labels. Invalidated by run events and every repo refresh. */
export function useRepoBranches() {
  return useQuery({
    queryKey: queryKeys.repoBranches,
    queryFn: ({ signal }) => getRepoBranches({ signal }),
  })
}

/** The classified branch list (`GET /repo/branches`, issue 08) for an EXPLICIT scope: the Git
 *  sidebar's Not landed count reads it above the `ProjectScopeProvider`. Shares
 *  `queryKeys.repoBranches`' entry for the project on screen, so its invalidations reach both. */
export function useProjectRepoBranches(scope: string) {
  return useQuery({
    queryKey: [scope, 'repo', 'branches'] as const,
    queryFn: ({ signal }) => getRepoBranches({ signal }, scope),
  })
}

/** The main working tree's structured diff behind the repo view's Changes section (R5 1.7).
 *  Same 409 stance as `useRunChanges`: "not a git repository" is an answer, not a hiccup. */
export function useRepoChanges() {
  return useQuery({
    queryKey: queryKeys.repoChanges,
    queryFn: ({ signal }) => getRepoChanges({ signal }),
    retry: false,
  })
}

/** One commit's structured diff (R5 repo view). A 409 ("unknown commit") is an answer retries
 *  cannot change. Cached per sha — commit history is immutable, so revisits are free. */
export function useRepoCommit(sha: string | undefined) {
  return useQuery({
    queryKey: queryKeys.repoCommit(sha ?? ''),
    queryFn: ({ signal }) => getRepoCommit(sha as string, { signal }),
    enabled: Boolean(sha),
    retry: false,
  })
}

/** The Settings → Agent defaults knobs (R6 1.5): base branch, default runner, system prompt, per-runner
 *  model presets. Task-start surfaces read this project-scoped query for both runner and model
 *  defaults; `/api/health` is workspace-level and intentionally describes only the boot repo. */
export function useConfig(projectId?: string) {
  return useQuery({
    queryKey: projectId ? ([projectId, 'config'] as const) : queryKeys.config,
    queryFn: ({ signal }) => getConfig({ signal, ...(projectId ? { projectId } : {}) }),
  })
}

/** The worktree management panel (#483). Invalidated by the global event stream when a run
 *  finishes or is reclaimed, so the on-disk list and total stay live while the panel is open. */
export function useWorktrees() {
  return useQuery({
    queryKey: queryKeys.worktrees,
    queryFn: ({ signal }) => getWorktrees({ signal }),
  })
}

/**
 * `useWorktrees` for an EXPLICIT scope (`'default'` for the boot project, the id otherwise — the
 * `useProjectRuns` convention). The Git sidebar renders in the shell, above the
 * `ProjectScopeProvider`, so `queryScope()` there still names the previous project. Shares
 * `queryKeys.worktrees`' entry for the project on screen, so the global stream's worktrees
 * invalidation keeps it live.
 */
export function useProjectWorktrees(scope: string) {
  return useQuery({
    queryKey: [scope, 'worktrees'] as const,
    queryFn: ({ signal }) => getWorktrees({ signal }, scope),
    // Existence must be current on every activation: an inactive project's run stream is
    // ignored, so a worktree deleted or recreated while another project was on screen would
    // otherwise be trusted for the default five minutes when the user comes back (A → B → A).
    // Zero staleness only refetches on mount, key change and focus — no polling.
    staleTime: 0,
  })
}

/** Explicit scope for shell consumers above ProjectScopeProvider. Boot shares its cache
 * with routed settings; capture the request scope before any asynchronous work. */
export function useProjectUiState(projectId: string, enabled = true, boot = false) {
  return useQuery({
    queryKey: [projectAddress({ projectId, boot }).cacheScope, 'ui-state'] as const,
    queryFn: ({ signal }) => getUiState({ signal }, projectId),
    // Cached state may come from an older server or predate validation. Keep the bag open.
    select: state => state.sidebarLimits === undefined ? state : { ...state, sidebarLimits: normalizeSidebarLimits(state.sidebarLimits) },
    enabled,
  })
}

export function useUiState() {
  return useProjectUiState(queryScope())
}

/** The selected project's agent-owned config files and precedence metadata. */
export function useAgentConfig() {
  return useQuery({
    queryKey: queryKeys.agentConfig,
    queryFn: ({ signal }) => getAgentConfig({ signal }),
  })
}

export function useAgentConfigFile(id: string | null) {
  return useQuery({
    queryKey: queryKeys.agentConfigFile(id ?? ''),
    queryFn: ({ signal }) => getAgentConfigFile(id as string, { signal }),
    enabled: id !== null,
  })
}

/** The selected project's `context.yaml` (Settings → Session context). */
export function useSessionContext() {
  return useQuery({
    queryKey: queryKeys.sessionContext,
    queryFn: ({ signal }) => getSessionContext({ signal }),
  })
}

/** The server's render of a draft: its problems and each block. Keeps the last answer while the next loads. */
export function useSessionContextPreview(content: string, role: SessionContextRole, sharedKey = '') {
  return useQuery({
    queryKey: queryKeys.sessionContextPreview(content, role, sharedKey),
    queryFn: ({ signal }) => postSessionContextPreview({ content, role }, { signal }),
    placeholderData: keepPreviousData,
    staleTime: 0,
    // Each edit asks again, and a refused draft (400) stays refused: show the failure at once.
    retry: false,
  })
}

export function usePutSessionContext() {
  const queryClient = useQueryClient()
  return useMutation({
    // The key is taken when the save starts, with the request: a save that ends after a project
    // switch writes only the project it started in.
    onMutate: () => ({ fileKey: queryKeys.sessionContext }),
    mutationFn: (body: SetSessionContextInput) => putSessionContext(body),
    onSuccess: (result, _body, context) => {
      if (context) queryClient.setQueryData(context.fileKey, result)
    },
  })
}

export function usePutAgentConfigFile(id: string) {
  const queryClient = useQueryClient()
  // Capture the scope at hook render time. A save may finish after the user has
  // switched projects; recomputing these getters in onSuccess would otherwise
  // write the previous project's response into the newly active cache.
  const listingKey = queryKeys.agentConfig
  const fileKey = queryKeys.agentConfigFile(id)
  return useMutation({
    mutationFn: (body: SetAgentConfigInput) => putAgentConfigFile(id, body),
    onSuccess: (result) => {
      queryClient.setQueryData(fileKey, result)
      void queryClient.invalidateQueries({ queryKey: listingKey })
    },
  })
}
