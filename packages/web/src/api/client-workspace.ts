import type {
  AgentAccountStatusResponse,
  AgentProfileResponse,
  AgentProfileSelectionsResponse,
  AgentProfilesResponse,
  CheckoutProjectInput,
  CreateAgentProfileInput,
  CreateProjectInput,
  CreateProjectResponse,
  CreateProjectWebhookInput,
  FsBrowseResponse,
  GithubOwnersResponse,
  HealthResponse,
  ProjectWebhookResponse,
  ProjectsResponse,
  ProviderConnectResponse,
  ProviderId,
  ProviderStatusResponse,
  RegisterProjectResponse,
  RemoveAgentProfileResponse,
  RemoveProjectResponse,
  SelectAgentProfileInput,
  SetWorkspaceConfigInput,
  SetWorkspaceUiStateInput,
  TestProjectWebhookResponse,
  UpdateAgentProfileInput,
  UpdateProjectInput,
  UpdateProjectResponse,
  UpdateProjectWebhookInput,
  WorkspaceConfigResponse,
  WorkspaceUiState,
} from '@open-mercato/cezar-api-client'
import { defined } from '@open-mercato/cezar-api-client/contract/defined'
import { githubOwnersResponseSchema } from '@open-mercato/cezar-api-client/contract/projects'
import { parseProviderStatusResponse } from '@/lib/provider-status'
import {
  ApiError,
  cez,
  errorFor,
  init,
  parseJson,
  send,
  unwrap,
  unwrapValidated,
  type ReadOptions,
} from './client-core'

/** Version, update check, repo/branch, and the tool probes behind the Tools menu. */
export async function getHealth(opts?: ReadOptions): Promise<HealthResponse> {
  return unwrap(await cez.api.v1.health.$get({}, init(opts)), '/health')
}

/** Host-local authentication state shared by every project. */
export async function getProviderStatus(
  refresh = false,
  opts?: ReadOptions,
): Promise<ProviderStatusResponse> {
  return parseProviderStatusResponse(
    await unwrap(
      await cez.api.v1.providers.status.$get(
        { query: refresh ? { refresh: '1' } : {} },
        init(opts),
      ),
      '/providers/status',
    ),
  )
}

/** The workspace project registry (multi-project spec). Workspace-level — one registry no
 *  matter which project is active, so it has no project-scoped spelling.
 *
 *  Migrated to the typed client: the path and the response shape are checked against the
 *  server's handler, and `ProjectsResponse` here is an assertion that the inferred type still
 *  matches the DTO rather than the source of it. */
export async function getProjects(opts?: ReadOptions): Promise<ProjectsResponse> {
  return unwrap(await cez.api.v1.projects.$get({}, init(opts)), '/projects')
}

/** One directory listing for the folder picker (`GET /api/fs/browse`, step 4.1). `path`
 *  omitted means the independently configured browse root, so the dialog never has to know
 *  or duplicate that workspace setting. */
export async function browseFs(
  path?: string,
  opts?: ReadOptions & {
    /** Include dot-directories. Off by default (project folders are not hidden); ON for the
     *  agent-account picker, where EVERY candidate is one — `~/.claude-klaudiusz` and friends. */
    showHidden?: boolean
  },
): Promise<FsBrowseResponse> {
  return unwrap(
    // An absent `path` stays absent rather than becoming `?path=`: the server distinguishes
    // "no path" (the configured browse root) from an empty one only by `?? ''`, but `hc` drops
    // an `undefined` value entirely, which keeps the URL the one this call always sent. Same
    // reason `showHidden` is omitted rather than sent as `0`.
    await cez.api.v1.fs.browse.$get(
      {
        query: {
          path: path === '' ? undefined : path,
          ...(opts?.showHidden ? { showHidden: '1' } : {}),
        },
      },
      init(opts),
    ),
    '/fs/browse',
  )
}

/**
 * Open a terminal signed in to `provider`, optionally for a NAMED account.
 *
 * `profileId` aims the login at one agent account (spec 2026-07-29-agent-profiles): the server
 * renders `CLAUDE_CONFIG_DIR=… claude /login` for it and fails closed rather than running the bare
 * command, because a terminal silently pointed at the wrong account is invisible to the user.
 * Omitted means the discovered account, which is how the Providers card has always called this.
 */
export async function connectProvider(
  provider: ProviderId,
  profileId?: string,
): Promise<ProviderConnectResponse> {
  return unwrap(
    await cez.api.v1.providers.connect.$post({
      json: { provider, ...(profileId ? { profileId } : {}) },
    }),
    '/providers/connect',
  )
}

export async function setProviderEnabled(
  provider: ProviderId,
  enabled: boolean,
): Promise<ProviderStatusResponse> {
  return parseProviderStatusResponse(
    await unwrap(
      await cez.api.v1.providers[':provider'].enabled.$put({
        param: { provider },
        json: { enabled },
      }),
      `/providers/${encodeURIComponent(provider)}/enabled`,
    ),
  )
}

export async function retryProviderAuth(
  provider: ProviderId,
  authFailureId: string,
): Promise<ProviderStatusResponse> {
  return parseProviderStatusResponse(
    await unwrap(
      await cez.api.v1.providers[':provider'].retry.$post({
        param: { provider },
        json: { authFailureId },
      }),
      `/providers/${encodeURIComponent(provider)}/retry`,
    ),
  )
}

/**
 * Register an existing folder (`POST /api/projects`, step 4.2).
 *
 * The one call in this module that does not funnel through `request()`: a 409 (already
 * registered) is NOT a failure for the add-project flow — the server answers it with the
 * EXISTING entry, which is exactly what the dialog needs to navigate to. Every other non-2xx
 * still becomes the same ApiError as anywhere else.
 */
export async function registerProject(root: string): Promise<RegisterProjectResponse> {
  const path = '/projects'
  const res = await send(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  })
  const body = await res.text()
  const parsed = parseJson(body)
  const project = (parsed as { project?: unknown } | undefined)?.project
  if ((res.ok || res.status === 409) && project !== undefined && project !== null) {
    return parsed as RegisterProjectResponse
  }
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  throw new ApiError(res.status, `the Squawk server answered ${path} without a project`)
}

/**
 * Clone a GitHub repo into the checkout root and register it (`POST /api/projects/checkout`,
 * step 4.3).
 *
 * On the typed client, unlike `registerProject` above: every non-2xx here IS a failure the dialog
 * must show (a 409 means the target folder exists and is not registered), so
 * `unwrap`'s ordinary contract is the right one. It surfaces the server's `{ error }` string as
 * the ApiError message, which the dialog renders. A clone into a root the registry already holds
 * answers 200 with that existing entry, which the dialog opens (hearsay-tools/squawk#1086).
 *
 * No timeout of our own: cloning a large repo legitimately takes minutes, and the request is
 * what the dialog waits on. Progress meanwhile comes from `checkout-progress` on the workspace
 * stream, keyed by `input.checkoutId`.
 */
export async function checkoutProject(input: CheckoutProjectInput): Promise<RegisterProjectResponse> {
  return unwrap(await cez.api.v1.projects.checkout.$post({ json: input }), '/projects/checkout')
}

/**
 * Create a new project — a git repo in the checkout root, optionally backed by a new private
 * GitHub repository — and register it (`POST /api/v1/projects/create`, spec
 * 2026-10-15-create-new-project). Same contract as `checkoutProject`: every non-2xx is a failure
 * the dialog shows verbatim, there is no timeout of our own, and progress arrives as
 * `checkout-progress` keyed by `input.checkoutId`. A 200 may carry `warning`: the project exists
 * and is registered, but its GitHub repository was left unfinished.
 */
export async function createProject(input: CreateProjectInput): Promise<CreateProjectResponse> {
  return unwrap(await cez.api.v1.projects.create.$post({ json: input }), '/projects/create')
}

/**
 * The accounts a new GitHub repository may belong to (`GET /api/v1/projects/github-owners`).
 * Validated: the dialog renders `owners[]` directly, and a server older than this route's shape
 * (or a proxy) must reject the query — which the dialog reads as "GitHub unavailable" — rather
 * than throw mid-render.
 */
export async function getGithubOwners(opts?: ReadOptions): Promise<GithubOwnersResponse> {
  return unwrapValidated(
    await cez.api.v1.projects['github-owners'].$get({}, init(opts)),
    '/projects/github-owners',
    githubOwnersResponseSchema,
  )
}

/**
 * Deregister a project (`DELETE /api/projects/:projectId`, step 4.4).
 *
 * Registry-only by contract — the server deletes NOTHING under the project root — so this
 * never needs an "are you sure you have a backup" ceremony beyond the pane's own confirm.
 * Ordinary `unwrap`: the 409s (running tasks, the boot project) are real failures whose
 * `{ error }` message is what the pane shows, and `errorFor` already surfaces it.
 */
export async function removeProject(projectId: string): Promise<RemoveProjectResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].$delete({ param: { projectId: encodeURIComponent(projectId) } }),
    `/projects/${encodeURIComponent(projectId)}`,
  )
}

/**
 * Set or clear a project's per-project concurrency ceiling
 * (`PATCH /api/v1/projects/:projectId`, spec 2026-07-22). `maxParallel: null`
 * clears the override back to "inherit the workspace cap"; an integer pins it.
 * The server applies the new ceiling live (semaphore refresh), so the answer is
 * the updated entry the pane swaps into its list.
 *
 * Deliberately NOT where a project's agent account is set — that is
 * `selectAgentProfile` (`PUT /api/v1/workspace/agent-profiles/selection`), so
 * the selection is stored beside the accounts it names.
 */
export async function updateProject(
  projectId: string,
  input: UpdateProjectInput,
): Promise<UpdateProjectResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].$patch({
      param: { projectId: encodeURIComponent(projectId) },
      json: input,
    }),
    `/projects/${encodeURIComponent(projectId)}`,
  )
}

/** "Send test" for the project's task webhook (#589): one `task.test` delivery, answered with
 *  the endpoint's status — the settings page reports it, it does not throw on a failed POST. */
export async function testProjectWebhook(projectId: string): Promise<TestProjectWebhookResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].webhook.test.$post({
      param: { projectId: encodeURIComponent(projectId) },
    }),
    `/projects/${encodeURIComponent(projectId)}/webhook/test`,
  )
}

/** Add one project webhook (hearsay-tools/cezarion#1576). 409 on a duplicate name or a full list. */
export async function createProjectWebhook(projectId: string, input: CreateProjectWebhookInput): Promise<ProjectWebhookResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].webhooks.$post({
      param: { projectId: encodeURIComponent(projectId) },
      json: input,
    }),
    `/projects/${encodeURIComponent(projectId)}/webhooks`,
  )
}

/** Edit one project webhook: each key applies only when named; an omitted token keeps it. */
export async function updateProjectWebhook(
  projectId: string,
  webhookId: string,
  input: UpdateProjectWebhookInput,
): Promise<ProjectWebhookResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].webhooks[':webhookId'].$patch({
      param: { projectId: encodeURIComponent(projectId), webhookId: encodeURIComponent(webhookId) },
      json: input,
    }),
    `/projects/${encodeURIComponent(projectId)}/webhooks/${encodeURIComponent(webhookId)}`,
  )
}

export async function removeProjectWebhook(projectId: string, webhookId: string): Promise<UpdateProjectResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].webhooks[':webhookId'].$delete({
      param: { projectId: encodeURIComponent(projectId), webhookId: encodeURIComponent(webhookId) },
    }),
    `/projects/${encodeURIComponent(projectId)}/webhooks/${encodeURIComponent(webhookId)}`,
  )
}

/** "Send test" for one webhook: one `task.test` delivery, answered with the endpoint's status. */
export async function testOneProjectWebhook(projectId: string, webhookId: string): Promise<TestProjectWebhookResponse> {
  return unwrap(
    await cez.api.v1.projects[':projectId'].webhooks[':webhookId'].test.$post({
      param: { projectId: encodeURIComponent(projectId), webhookId: encodeURIComponent(webhookId) },
    }),
    `/projects/${encodeURIComponent(projectId)}/webhooks/${encodeURIComponent(webhookId)}/test`,
  )
}

/** The cross-project GUI state (`~/.cezar/ui-state.json`, step 2.7). Workspace-level:
 *  `apiPath` never prefixes `/api/workspace/*`. */
export async function getWorkspaceUiState(opts?: ReadOptions): Promise<WorkspaceUiState> {
  return unwrap(await cez.api.v1.workspace['ui-state'].$get({}, init(opts)), '/workspace/ui-state')
}

/** Shallow top-level merge server-side, same as its per-repo twin — send whole top-level
 *  objects (`{ sidebar: {...} }`), never a nested leaf alone. Answers the merged state. */
export async function putWorkspaceUiState(
  patch: SetWorkspaceUiStateInput,
  opts: { keepalive?: boolean | undefined } = {},
): Promise<WorkspaceUiState> {
  return unwrap(
    await cez.api.v1.workspace['ui-state'].$put(
      { json: patch },
      { init: { ...defined({ keepalive: opts.keepalive }) } },
    ),
    '/workspace/ui-state',
  )
}

/**
 * The global settings slice of `~/.cezar/config.json` (step 2.7) — Settings → Resources, (step 4.4)
 * the checkout-root field, and the agent defaults.
 *
 * `agentDefaults` is materialized HERE rather than guarded at each read site, for the same reason
 * the agent-accounts collections are: during development the cockpit and the server can be
 * different versions (Vite serves this bundle while `dist/` or another process serves the API), and
 * an older server answering without the key crashed the accounts page on `.runner`. One boundary,
 * one place a missing key becomes the empty answer it means.
 */
export async function getWorkspaceConfig(opts?: ReadOptions): Promise<WorkspaceConfigResponse> {
  const answer = await unwrap(
    await cez.api.v1.workspace.config.$get({}, init(opts)),
    '/workspace/config',
  )
  return { ...answer, agentDefaults: answer.agentDefaults ?? {} }
}

/**
 * Every agent account on this machine (spec 2026-07-29-agent-profiles) — the discovered defaults
 * plus any extra config dirs. Workspace-level, so never scope-prefixed. Hosted mode answers
 * `{editable: false, profiles: [], …}` rather than leaking host paths.
 *
 * The collections are filled in HERE rather than guarded at each of the ~5 read sites. During
 * development the cockpit and the server can be different versions (Vite serves this bundle while
 * `dist/` or another process serves the API), and an older server answering without `files` or
 * `selections` crashed the accounts pane on `.map` of undefined. Normalizing at the boundary — the
 * job this module already does for provider status — means every consumer can trust the shape, and
 * the next additive field is one line here instead of a hunt for missing `??`s.
 */
export async function getAgentProfiles(opts?: ReadOptions): Promise<AgentProfilesResponse> {
  const answer = await unwrap(
    await cez.api.v1.workspace['agent-profiles'].$get({}, init(opts)),
    '/workspace/agent-profiles',
  )
  return {
    ...answer,
    profileCapableProviders: answer.profileCapableProviders ?? [],
    selections: answer.selections ?? {},
    profiles: answer.profiles ?? [],
  }
}

/** Register an extra config dir as an account. The id is allocated server-side from the label. */
export async function createAgentProfile(
  input: CreateAgentProfileInput,
): Promise<AgentProfileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'].$post({ json: input }),
    '/workspace/agent-profiles',
  )
}

/** One account's auth state, probed for real (spec 2026-07-29-agent-profiles). Off the listing on
 *  purpose: a probe shells out to an agent CLI, so the pane paints first and fills rows in as these
 *  land. `refresh` drops the server's cached answer for this account and re-probes. */
export async function getAgentAccountStatus(
  routeId: string,
  opts?: ReadOptions & { refresh?: boolean },
): Promise<AgentAccountStatusResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].status.$get(
      {
        param: { id: encodeURIComponent(routeId) },
        query: opts?.refresh ? { refresh: '1' } : {},
      },
      init(opts),
    ),
    `/workspace/agent-profiles/${encodeURIComponent(routeId)}/status`,
  )
}

/** Point one project's provider at an account. `profileId: null` clears it back to the
 *  discovered account. Lives on the accounts family, not `PATCH /projects`, because the selection
 *  is stored beside the accounts it names. */
export async function selectAgentProfile(
  input: SelectAgentProfileInput,
): Promise<AgentProfileSelectionsResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'].selection.$put({ json: input }),
    '/workspace/agent-profiles/selection',
  )
}

/** Rename an account or repoint its folder. Partial — send only what changed. */
export async function updateAgentProfile(
  id: string,
  input: UpdateAgentProfileInput,
): Promise<AgentProfileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].$patch({
      param: { id: encodeURIComponent(id) },
      json: input,
    }),
    `/workspace/agent-profiles/${encodeURIComponent(id)}`,
  )
}

/** Deregister an account. The folder is never touched, and projects using it fall back to the
 *  discovered default (the server scrubs their references in the same write). */
export async function removeAgentProfile(id: string): Promise<RemoveAgentProfileResponse> {
  return unwrap(
    await cez.api.v1.workspace['agent-profiles'][':id'].$delete({
      param: { id: encodeURIComponent(id) },
    }),
    `/workspace/agent-profiles/${encodeURIComponent(id)}`,
  )
}

/** Partial update — absent keys stay untouched; answers the merged config. A `projectsDir`
 *  the server cannot write to comes back as a 400 `ApiError` whose message is the reason,
 *  which is exactly what the Projects pane renders inline (step 4.4). */
export async function putWorkspaceConfig(
  patch: SetWorkspaceConfigInput,
): Promise<WorkspaceConfigResponse> {
  return unwrap(await cez.api.v1.workspace.config.$put({ json: patch }), '/workspace/config')
}

/** Latest clone progress for finite-HTTP recovery; the mutation response decides success. */
export async function getCheckoutProgress(checkoutId: string, opts?: ReadOptions) {
  return unwrap(await cez.api.v1.projects.checkout[':checkoutId'].progress.$get({ param: { checkoutId } }, init(opts)), '/projects/checkout/progress')
}
