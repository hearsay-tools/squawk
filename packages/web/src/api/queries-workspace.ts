import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getApiBaseUrl } from '@open-mercato/cezar-api-client/utils/project-scope'
import type {
  CheckoutProjectInput,
  CreateAgentProfileInput,
  CreateProjectInput,
  CreateProjectWebhookInput,
  HealthResponse,
  ProjectListEntry,
  ProjectsResponse,
  ProviderId,
  ProviderStatusResponse,
  SelectAgentProfileInput,
  UpdateAgentProfileInput,
  UpdateProjectInput,
  UpdateProjectWebhookInput,
} from '@open-mercato/cezar-api-client'
import { liveRefetchInterval } from '@/lib/live-refetch'
import { githubRepoBase } from '@/lib/github-repo-base'
import { normalizeTagsForDisplay } from '@/lib/project-tags'
import { mergeProviderStatusResponse } from '@/lib/provider-status'
import { invalidateRunnerModels } from './model-catalog'
import { configureLiveSession, resetLiveSession } from './live-coordinator'
import { useProjectScope } from './project-scope-context'
import { subscribeTopic } from './ws'
import { queryKeys, workspaceQueryKeys } from './query-keys'
import {
  browseFs,
  checkoutProject,
  connectProvider,
  createAgentProfile,
  createProject,
  createProjectWebhook,
  getAgentAccountStatus,
  getAgentProfiles,
  getGithubOwners,
  getHealth,
  getProjects,
  getProviderStatus,
  getWorkspaceConfig,
  getWorkspaceUiState,
  registerProject,
  removeAgentProfile,
  removeProject,
  removeProjectWebhook,
  retryProviderAuth,
  selectAgentProfile,
  testOneProjectWebhook,
  testProjectWebhook,
  updateAgentProfile,
  updateProject,
  updateProjectWebhook,
} from './client'

export function useProviderStatus() {
  const queryClient = useQueryClient()
  return useQuery({
    queryKey: workspaceQueryKeys.providerStatus,
    queryFn: async ({ signal }) => {
      const requestStart = queryClient.getQueryData<ProviderStatusResponse>(
        workspaceQueryKeys.providerStatus,
      )
      const response = await getProviderStatus(false, { signal })
      return mergeProviderStatusResponse(
        requestStart,
        queryClient.getQueryData(workspaceQueryKeys.providerStatus),
        response,
      )
    },
    // One bootstrap per session cache. Runtime incidents arrive over the workspace stream and
    // user-driven Connect/Check again/Try again actions update this same key immediately; a
    // background interval only re-probes unchanged credentials and can repeatedly challenge a
    // reverse-proxy-authenticated mobile browser. A focus refresh is allowed once the answer is
    // five minutes old, covering credentials changed outside Squawk without permanent polling.
    staleTime: 5 * 60_000,
    refetchInterval: liveRefetchInterval(false),
    refetchOnWindowFocus: true,
  })
}

export function useRefreshProviderStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => getProviderStatus(true),
    onMutate: () => queryClient.getQueryData<ProviderStatusResponse>(workspaceQueryKeys.providerStatus),
    onSuccess: (result, _variables, requestStart) => {
      queryClient.setQueryData<ProviderStatusResponse>(
        workspaceQueryKeys.providerStatus,
        (cached) => mergeProviderStatusResponse(requestStart, cached, result),
      )
      void invalidateRunnerModels(queryClient)
    },
  })
}

export function useRetryProviderAuth() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      provider,
      authFailureId,
    }: {
      provider: ProviderId
      authFailureId: string
    }) => retryProviderAuth(provider, authFailureId),
    onMutate: () => queryClient.getQueryData<ProviderStatusResponse>(workspaceQueryKeys.providerStatus),
    onSuccess: (result, variables, requestStart) => {
      queryClient.setQueryData<ProviderStatusResponse>(workspaceQueryKeys.providerStatus, (cached) =>
        mergeProviderStatusResponse(requestStart, cached, result, variables.authFailureId))
      void invalidateRunnerModels(queryClient, variables.provider)
    },
  })
}

/** The workspace project registry (`GET /api/projects`): the `/p/:projectId` route gate's
 *  known/unknown answer, the boot slug behind the `/p/default` alias, and the list the
 *  unknown-project screen offers. Step 3.3's sidebar reads it too. */
export function useProjects(options: { retryOnMount?: boolean } = {}) {
  return useQuery({
    queryKey: workspaceQueryKeys.projects,
    queryFn: ({ signal }) => getProjects({ signal }),
    ...options,
  })
}

/** One directory listing for the add-project folder picker (step 4.2). `path: null` asks for
 *  the browse root. Retries are off: the interesting failures here are the deliberate 400/404s
 *  (outside the root, no such directory) — re-asking cannot change those answers, and the
 *  dialog shows the server's own words instead. */
export function useFsBrowse(path: string | null, showHidden = false) {
  return useQuery({
    // `showHidden` is part of the key: the two listings of one directory are different answers,
    // and sharing a cache entry would show whichever caller asked first.
    queryKey: workspaceQueryKeys.fsBrowse(path, showHidden),
    queryFn: ({ signal }) => browseFs(path ?? undefined, { signal, showHidden }),
    retry: false,
  })
}

/**
 * Register a browsed folder (`POST /api/projects`, step 4.2).
 *
 * Invalidates the registry so the sidebar grows the new project WITHOUT a reload — the caller
 * navigates to `/p/<id>/` on success, and the `/p/:projectId` route gate reads that same query
 * to decide the id is known, so a stale list would bounce a just-added project to the
 * unknown-project screen.
 *
 * A 409 (already registered) resolves rather than rejects — see `registerProject` in client.ts;
 * the caller navigates to the existing entry either way.
 */
export function useRegisterProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (root: string) => registerProject(root),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
  })
}

/**
 * Deregister a project (`DELETE /api/projects/:projectId`, step 4.4 — Settings → Projects).
 *
 * Same registry invalidation as the two add paths, for the mirror reason: the sidebar must
 * LOSE the group without a reload. The server also emits `project-removed` on the workspace
 * stream, which invalidates the same key for every OTHER open tab (global-events.tsx) — this
 * one is for the tab that pressed the button, whose own answer arrives before the event.
 *
 * No retry: the interesting failures are the deliberate 409s (running tasks, the boot
 * project), and re-asking cannot change those answers.
 *
 * The invalidation is deliberately NOT returned: TanStack awaits a promise a mutation callback
 * returns before running the per-call ones, so returning it would make the caller's `onSuccess`
 * wait for the registry REFETCH. Settings → General removes the project its own URL names and
 * navigates away in that callback — gating that on a second round-trip leaves the user on a page
 * for a project that no longer exists for as long as the refetch takes.
 */
export function useRemoveProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (projectId: string) => removeProject(projectId),
    retry: false,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects })
    },
  })
}

/**
 * Edit one registry entry — the per-project concurrency ceiling (spec 2026-07-22) and the
 * grouping tags — from Settings → Projects.
 *
 * **Optimistic, and that is load-bearing rather than cosmetic.** The editors are bound to the
 * server value with no local mirror, so between the PATCH and the refetch the cached project
 * still holds the OLD list. Adding two tags in a row therefore read the stale list twice and the
 * second save overwrote the first: click `api`, click `web`, and `api` was gone — the whole list
 * is replaced wholesale, so a stale read is a silent deletion, not a stale display.
 *
 * Writing the new value into the cache immediately closes that window: the next click composes on
 * top of it. The server's own answer then replaces the row (it is the authority on normalization),
 * and the final invalidate re-reads the registry. A failure rolls the snapshot back, so a refused
 * edit leaves the row exactly as it was.
 *
 * No retry — an out-of-range value or unknown id (400/404) is a deterministic refusal re-asking
 * cannot change.
 */
export function useUpdateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    // Forwarded whole rather than key by key: the body is partial, so an unlisted key would be
    // silently dropped instead of sent — which is how `agentProfile` would have gone missing.
    mutationFn: (variables: { id: string } & UpdateProjectInput) => {
      const { id, ...patch } = variables
      return updateProject(id, patch)
    },
    retry: false,
    onMutate: async ({ id, ...patch }) => {
      await queryClient.cancelQueries({ queryKey: workspaceQueryKeys.projects })
      const previous = queryClient.getQueryData<ProjectsResponse>(workspaceQueryKeys.projects)
      queryClient.setQueryData<ProjectsResponse>(workspaceQueryKeys.projects, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              projects: current.projects.map((project) =>
                project.id === id ? applyProjectPatch(project, patch) : project,
              ),
            },
      )
      return { previous }
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) {
        queryClient.setQueryData(workspaceQueryKeys.projects, context.previous)
      }
    },
    onSuccess: ({ project: updated }) => {
      // The server is the authority on normalization (trim, case-insensitive dedupe, sort), so
      // its entry replaces the optimistic one rather than merging with it.
      queryClient.setQueryData<ProjectsResponse>(workspaceQueryKeys.projects, (current) =>
        current === undefined
          ? current
          : {
              ...current,
              projects: current.projects.map((project) =>
                project.id === updated.id ? updated : project,
              ),
            },
      )
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
  })
}

/** One registry entry with a PATCH body applied — the same per-key rule the route follows: a
 *  field changes only when the body NAMED it, and `null` (or, for tags, an empty list) clears. */
function applyProjectPatch(
  project: ProjectListEntry,
  patch: UpdateProjectInput,
): ProjectListEntry {
  const { maxParallel: _mp, tags: _tags, ...rest } = project
  const next: ProjectListEntry = { ...rest }
  const maxParallel = 'maxParallel' in patch ? patch.maxParallel : project.maxParallel
  if (maxParallel !== null && maxParallel !== undefined) next.maxParallel = maxParallel
  const tags = 'tags' in patch && patch.tags !== undefined ? patch.tags : project.tags
  const normalized = tags === null || tags === undefined ? [] : normalizeTagsForDisplay(tags)
  if (normalized.length > 0) next.tags = normalized
  // The token is write-only (#589): an omitted one keeps whatever was set, `''` clears it.
  if ('webhook' in patch && patch.webhook !== undefined) {
    if (patch.webhook === null) delete next.webhook
    else {
      const tokenSet = patch.webhook.token === undefined ? project.webhook?.tokenSet ?? false : patch.webhook.token !== ''
      next.webhook = { url: patch.webhook.url, tokenSet }
    }
  }
  return next
}

/** "Send test" (#589) — the answer is the result; nothing cached changes. */
export function useTestProjectWebhook() {
  return useMutation({ mutationFn: (projectId: string) => testProjectWebhook(projectId), retry: false })
}

/**
 * The project-webhook mutations (hearsay-tools/cezarion#1576). Not optimistic: each form keeps
 * its own draft, so nothing reads the cache between the click and the answer. The answer's
 * `project` replaces the cached entry, and the invalidate re-reads the registry.
 */
function useProjectWebhookMutation<TVariables, TResult extends { project: ProjectListEntry }>(
  mutationFn: (variables: TVariables) => Promise<TResult>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    retry: false,
    onSuccess: ({ project: updated }) => {
      queryClient.setQueryData<ProjectsResponse>(workspaceQueryKeys.projects, (current) =>
        current === undefined
          ? current
          : { ...current, projects: current.projects.map((project) => (project.id === updated.id ? updated : project)) },
      )
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
  })
}

export function useCreateProjectWebhook() {
  return useProjectWebhookMutation((variables: { projectId: string } & CreateProjectWebhookInput) => {
    const { projectId, ...input } = variables
    return createProjectWebhook(projectId, input)
  })
}

export function useUpdateProjectWebhook() {
  return useProjectWebhookMutation((variables: { projectId: string; webhookId: string } & UpdateProjectWebhookInput) => {
    const { projectId, webhookId, ...input } = variables
    return updateProjectWebhook(projectId, webhookId, input)
  })
}

export function useRemoveProjectWebhook() {
  return useProjectWebhookMutation(({ projectId, webhookId }: { projectId: string; webhookId: string }) =>
    removeProjectWebhook(projectId, webhookId),
  )
}

/** "Send test" for one webhook — the answer is the result; nothing cached changes. */
export function useTestOneProjectWebhook() {
  return useMutation({
    mutationFn: ({ projectId, webhookId }: { projectId: string; webhookId: string }) => testOneProjectWebhook(projectId, webhookId),
    retry: false,
  })
}

/**
 * The three agent-account mutations (spec 2026-07-29-agent-profiles).
 *
 * All three invalidate the PROJECTS list as well as the account list: deleting an account scrubs
 * every project's reference to it server-side, so a projects cache left alone would keep showing
 * a selection that no longer exists.
 */
function useAgentProfileMutation<TVariables>(
  mutationFn: (variables: TVariables) => Promise<unknown>,
) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    retry: false,
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles }),
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
        queryClient.invalidateQueries({ predicate: ({ queryKey }) => queryKey[1] === 'runner-skills' }),
        invalidateRunnerModels(queryClient),
      ])
    },
    onError: () => {
      // A 409 can mean the host withdrew `remote-settings` while this page was open; re-read
      // capabilities and the account listing so edit controls do not stay stale.
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles, exact: true })
    },
  })
}

export function useCreateAgentProfile() {
  return useAgentProfileMutation((input: CreateAgentProfileInput) => createAgentProfile(input))
}

export function useUpdateAgentProfile() {
  return useAgentProfileMutation((variables: { id: string } & UpdateAgentProfileInput) => {
    const { id, ...patch } = variables
    return updateAgentProfile(id, patch)
  })
}

export function useRemoveAgentProfile() {
  return useAgentProfileMutation((id: string) => removeAgentProfile(id))
}

/** Point one project's provider at an account (spec 2026-07-29-agent-profiles). */
export function useSelectAgentProfile() {
  return useAgentProfileMutation((input: SelectAgentProfileInput) => selectAgentProfile(input))
}

/**
 * One account's auth state — the GAP-FILLER, not the normal path.
 *
 * The listing carries a status whenever the server has one cached, which after the boot warm is
 * almost always. This covers the rest: an account added mid-session, or a cache that has aged out.
 * Each row asks for its own in parallel, so the pane still paints from the spawn-free listing and
 * fills dots in as answers arrive rather than blocking on a spawn per provider AND per account.
 */
export function useAgentAccountStatus(routeId: string, enabled: boolean) {
  return useQuery({
    queryKey: workspaceQueryKeys.agentAccountStatus(routeId),
    queryFn: ({ signal }) => getAgentAccountStatus(routeId, { signal }),
    // Only when the listing had nothing cached to give us. The server warms this at boot and keeps
    // a connected answer for minutes, so in the normal case the listing already carries it and this
    // never fires — no request, no CLI spawn, no "Checking…" flicker.
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}

/**
 * Sign IN to one agent account — the last mile of "add account → Connect → the CLI creates the
 * folder", which is the documented first-run sequence and the only way a second login can be
 * created from Squawk.
 *
 * Invalidates both the account listing and the provider card: the login the user just opened is
 * for a named account, but the terminal they finish it in can equally be the discovered one, and a
 * stale card is what makes people press Connect twice.
 */
export function useConnectAgentAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ provider, profileId }: { provider: ProviderId; profileId?: string }) =>
      connectProvider(provider, profileId),
    retry: false,
    onSuccess: async (_result, { provider }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles }),
        queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.providerStatus }),
        invalidateRunnerModels(queryClient, provider, 'none'),
      ])
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.health })
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles, exact: true })
    },
  })
}

/**
 * Re-probe ONE account for real (`?refresh=1`), for the "Check again" the pane offers beside
 * Connect — the affordance the cached-by-default listing is designed around.
 *
 * Writes the answer straight into the per-account status cache so the row updates without a second
 * round-trip, and never retries: the interesting failures here are the server's own refusals.
 */
export function useRecheckAgentAccount() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (routeId: string) => getAgentAccountStatus(routeId, { refresh: true }),
    retry: false,
    onSuccess: (answer, routeId) => {
      queryClient.setQueryData(workspaceQueryKeys.agentAccountStatus(routeId), answer)
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.agentProfiles })
      void invalidateRunnerModels(queryClient, answer.status.provider)
    },
  })
}

/**
 * Clone a GitHub repo into the checkout root and register it (`POST /api/projects/checkout`,
 * step 4.3). Same registry invalidation as `useRegisterProject` and for the same reason — the
 * caller navigates to `/p/<id>/`, and the route gate reads that query to decide the id is known.
 *
 * No retry: a clone is a long, side-effecting call. Re-running it after a failure would race
 * the server's own cleanup of the partial directory and land on the 409 instead of the real
 * error, which is precisely the confusing outcome the cleanup exists to prevent.
 */
export function useCheckoutProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CheckoutProjectInput) => checkoutProject(input),
    retry: false,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
  })
}

/** Create and register a new project (spec 2026-10-15-create-new-project). */
export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateProjectInput) => createProject(input),
    retry: false,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.projects }),
  })
}

/** Who a new GitHub repository may belong to. `enabled` is the dialog being open: `gh api` is a
 *  network call, so nothing reads it until someone is about to choose. No retry — a failure is
 *  an answer ("GitHub unavailable"), and the local project stays available. */
export function useGithubOwners({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: workspaceQueryKeys.githubOwners,
    queryFn: ({ signal }) => getGithubOwners({ signal }),
    enabled,
    staleTime: 60_000,
    retry: false,
  })
}

/**
 * The ONE session-long `health` topic subscription. Call it exactly once, at the app root
 * (`GlobalEventsProvider`) — never from `useHealth`.
 */
export function useHealthSubscription(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    let releaseTopic: (() => void) | undefined

    const syncTransport = (): void => {
      const health = queryClient.getQueryData<HealthResponse>(queryKeys.health)
      if (!health) return
      configureLiveSession({ bootProject: health.bootProject ?? 'default', apiBase: getApiBaseUrl() })
      releaseTopic ??= subscribeTopic('health', (data) => {
        queryClient.setQueryData(queryKeys.health, data as HealthResponse)
      })
    }

    syncTransport()
    const releaseCache = queryClient.getQueryCache().subscribe(syncTransport)
    return () => {
      releaseCache()
      releaseTopic?.()
      resetLiveSession()
    }
  }, [queryClient])
}

/** Version + update check + repo/branch + tool probes. Feeds the sidebar's repo and version
 *  chips and (Step 4.2) the Tools menu. */
export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: ({ signal }) => getHealth({ signal }),
  })
}

/**
 * The GitHub web root (`https://github.com/owner/repo`) of the project currently on screen, or
 * undefined when it cannot be proven — the only authority `taskIssueUrl` may synthesize a link
 * against (#526).
 */
export function useProjectRepoBase(
  explicitProjectId?: string,
  options?: { retryOnMount?: boolean },
): string | undefined {
  const health = useHealth().data
  const projects = useProjects(options).data?.projects
  const scope = useProjectScope()
  // A surface standing in a project other than the routed one (the sidebar's per-project lists)
  // names it; everyone else reads the route's.
  const projectId = explicitProjectId ?? scope.projectId
  const scopedId = projectId ?? health?.bootProject
  const registered = scopedId === undefined ? undefined : projects?.find((project) => project.id === scopedId)
  if (registered?.repoUrl) return registered.repoUrl
  const isBootProject = projectId === null || projectId === health?.bootProject
  return isBootProject ? githubRepoBase(health?.repo?.remote) : undefined
}

/** The cross-project GUI state (`~/.cezar/ui-state.json`). Read once and cached — the sidebar
 *  applies its own writes optimistically and PUTs behind a debounce, so nothing polls this. */
export function useWorkspaceUiState() {
  return useQuery({
    queryKey: workspaceQueryKeys.uiState,
    queryFn: ({ signal }) => getWorkspaceUiState({ signal }),
  })
}

/** The global settings slice of `~/.cezar/config.json` — Settings → Resources (step 3.5) and
 *  the Projects pane's checkout root (step 4.4). Not scope-led: one workspace, one answer. */
export function useWorkspaceConfig() {
  return useQuery({
    queryKey: workspaceQueryKeys.config,
    queryFn: ({ signal }) => getWorkspaceConfig({ signal }),
  })
}

/**
 * Every agent account on this machine (spec 2026-07-29-agent-profiles).
 *
 * Read by three surfaces — the Accounts settings section, the per-project picker in Settings →
 * Agents, and the composer's override — so it is one cached query rather than three fetches.
 * Not scope-led: one machine, one set of accounts.
 */
export function useAgentProfiles() {
  return useQuery({
    queryKey: workspaceQueryKeys.agentProfiles,
    queryFn: ({ signal }) => getAgentProfiles({ signal }),
  })
}
