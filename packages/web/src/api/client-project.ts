import type { RunnerSkillList } from '@open-mercato/cezar-api-client/contract/runner-skills'
import type {
  AgentConfigFileContent,
  AgentConfigListing,
  AutomationCheck,
  AutomationCheckQueuedResponse,
  AutomationCreateResponse,
  AutomationLogResponse,
  AutomationResponse,
  AutomationRetryResponse,
  AutomationRunResponse,
  AutomationsResponse,
  ChangesPayload,
  ConfigResponse,
  CreateAutomationInput,
  DeleteBranchesInput,
  DeleteBranchesResponse,
  DeleteWorkflowResponse,
  ParsedWorkflow,
  PlanResponse,
  ReclaimWorktreeResponse,
  ReclaimWorktreesResponse,
  RepoBranchResponse,
  RepoBranchesResponse,
  RepoCommitPayload,
  RepoPullBranchesResponse,
  RepoPullConfirmation,
  RepoPullInput,
  RepoPullResponse,
  RepoResponse,
  Runner,
  SaveWorkflowInput,
  SaveWorkflowResponse,
  SessionContextPreview,
  SessionContextPreviewRequest,
  SessionContextState,
  SetAgentConfigInput,
  SetConfigInput,
  SetConfigResponse,
  SetSessionContextInput,
  UiState,
  UpdateAutomationInput,
  WorkflowsResponse,
  WorktreesResponse,
} from '@open-mercato/cezar-api-client'
import { queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import {
  repoPullBranchesResponseSchema,
  repoPullConfirmationSchema,
  repoPullResponseSchema,
} from '@open-mercato/cezar-api-client/contract/repo'
import {
  ApiError,
  cez,
  errorFor,
  init,
  parseJson,
  unwrap,
  unwrapValidated,
  type ReadOptions,
} from './client-core'

export async function getUiState(opts?: ReadOptions, scope = queryScope()): Promise<UiState> {
  return unwrap(
    await cez.api.v1.p[':projectId']['ui-state'].$get(
      { param: { projectId: scope } },
      init(opts),
    ),
    '/ui-state',
  )
}

/** Merges server-side (the stored object spread under the patch) and answers the merged state. */
export async function putUiState(patch: UiState, scope = queryScope()): Promise<UiState> {
  return unwrap(
    await cez.api.v1.p[':projectId']['ui-state'].$put({
      param: { projectId: scope },
      json: patch,
    }),
    '/ui-state',
  )
}

export async function getWorkflows(opts?: ReadOptions): Promise<WorkflowsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows.$get(
      { param: { projectId: opts?.projectId ?? queryScope() } },
      init(opts),
    ),
    '/workflows',
  )
}

export async function getRunnerSkills(
  runner: Runner,
  account?: string | null,
  opts?: ReadOptions & { refresh?: boolean },
): Promise<RunnerSkillList> {
  return unwrap(
    await cez.api.v1.p[':projectId']['runner-skills'].$get(
      { param: { projectId: opts?.projectId ?? queryScope() }, query: {
        runner, ...(account ? { account } : {}), ...(opts?.refresh ? { refresh: '1' as const } : {}),
      } },
      init(opts),
    ),
    '/runner-skills',
  )
}

export async function getRepo(
  opts?: ReadOptions,
  /** For callers outside the routed view's scope (the shell's Git sidebar); else `queryScope()`. */
  projectId?: string,
): Promise<RepoResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.$get({ param: { projectId: projectId ?? queryScope() } }, init(opts)),
    '/repo',
  )
}

/** The Git view's classified branch list (issue 08 §B2): Not landed, Cleanup's branch card and
 *  All branches' class labels all read it. Never an error outside a repository (an empty list). */
export async function getRepoBranches(opts?: ReadOptions, projectId?: string): Promise<RepoBranchesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.branches.$get({ param: { projectId: projectId ?? queryScope() } }, init(opts)),
    '/repo/branches',
  )
}

/** Delete local branches (issue 08 §B3). The server re-classifies every name: `merged`/`empty` go
 *  in bulk, a `not-landed`/`orphan` branch only alone with `confirm` equal to its name. A 409
 *  (nothing deleted) throws an `ApiError` carrying the server's reason. */
export async function deleteRepoBranches(input: DeleteBranchesInput): Promise<DeleteBranchesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.branches.delete.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/repo/branches/delete',
  )
}

/** Local branches eligible for the Git header's pull target picker. */
export async function getRepoPullBranches(opts?: ReadOptions): Promise<RepoPullBranchesResponse> {
  return unwrapValidated(
    await cez.api.v1.p[':projectId'].repo.pull.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/repo/pull',
    repoPullBranchesResponseSchema,
  )
}

/**
 * Switch to (when needed) and pull one local branch. A structured 409 is an expected decision
 * point for the UI, while every other refusal keeps the client-wide ApiError contract.
 */
export async function pullRepo(
  input: RepoPullInput,
  /** For callers outside the routed view's scope (the shell's Git sidebar); else `queryScope()`. */
  projectId?: string,
): Promise<RepoPullResponse | RepoPullConfirmation> {
  const response = await cez.api.v1.p[':projectId'].repo.pull.$post({
    param: { projectId: projectId ?? queryScope() },
    json: input,
  })
  // The route type knows only its own 200/409 answers. The transport can still receive any HTTP
  // status from a proxy or stale server, so keep that runtime fallback typed as the Response it is.
  const transport = response as Response
  const body = await transport.text()
  const parsed = parseJson(body)

  if (transport.status === 409) {
    const confirmation = repoPullConfirmationSchema.safeParse(parsed)
    if (confirmation.success) return confirmation.data
    throw errorFor(transport.status, transport.statusText, body)
  }
  if (!transport.ok) throw errorFor(transport.status, transport.statusText, body)
  if (parsed === undefined) {
    throw new ApiError(transport.status, `the Squawk server answered /repo/pull with a non-JSON body`)
  }
  const result = repoPullResponseSchema.safeParse(parsed)
  if (!result.success) {
    throw new ApiError(transport.status, `the Squawk server answered /repo/pull with an unexpected body`)
  }
  return result.data
}

/** Repo-view branch action (R5): switch to an existing branch, or create one (from `from` or
 *  HEAD) and switch. Invalid names, unknown start points and dirty-tree checkout conflicts
 *  all come back as 409 whose ApiError carries git's own reason. */
export async function createRepoBranch(
  input: { name: string; from?: string },
  /** For callers outside the routed view's scope (the shell's Git sidebar); else `queryScope()`. */
  projectId?: string,
): Promise<RepoBranchResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.branch.$post({
      param: { projectId: projectId ?? queryScope() },
      json: input,
    }),
    '/repo/branch',
  )
}

/** The main working tree's structured uncommitted diff vs HEAD (R5 repo view). 409 (as an
 *  ApiError with the reason) when the server runs outside a git repository. */
export async function getRepoChanges(opts?: ReadOptions): Promise<ChangesPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.changes.$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/repo/changes',
  )
}

/** One commit's structured diff (R5 repo view): `?structured=1` on the legacy commit route —
 *  additive, the text-blob answer stays for the legacy UI. 409 + reason for unknown shas. */
export async function getRepoCommit(sha: string, opts?: ReadOptions): Promise<RepoCommitPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].repo.commit[':sha'].$get(
      { param: { projectId: opts?.projectId ?? queryScope(), sha: encodeURIComponent(sha) }, query: { structured: '1' } },
      init(opts),
    ),
    '/repo/commit/:sha',
  )
}

/** The Settings → Agent defaults knobs in one read (`GET /api/config`, additive R6 route). */
export async function getConfig(opts?: ReadOptions): Promise<ConfigResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].config.$get({ param: { projectId: queryScope() } }, init(opts)),
    '/config',
  )
}

/** Set/clear the agents' config knobs — base branch, default runner, system prompt, per-runner
 *  model presets (Settings → Agent defaults, R6 1.5). Merged into the raw config.json server-side so
 *  unrelated user keys survive; `null` clears a knob back to its default. */
export async function putConfig(
  patch: SetConfigInput,
  /** For callers outside the routed view's scope (the shell's Git sidebar); else `queryScope()`. */
  projectId?: string,
): Promise<SetConfigResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].config.$put({
      param: { projectId: projectId ?? queryScope() },
      json: patch,
    }),
    '/config',
  )
}

/** The selected project's agent-owned config catalog and current file state. */
export async function getAgentConfig(opts: ReadOptions = {}): Promise<AgentConfigListing> {
  return unwrap(
    await cez.api.v1.p[':projectId']['agent-config'].$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/agent-config',
  )
}

/** One selected-project config file's raw contents and optimistic version. */
export async function getAgentConfigFile(
  id: string,
  opts: ReadOptions = {},
): Promise<AgentConfigFileContent> {
  return unwrap(
    await cez.api.v1.p[':projectId']['agent-config'][':id'].$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    `/agent-config/${encodeURIComponent(id)}`,
  )
}

/** Save inside the selected project scope; send() adds /api/p/:projectId. */
export async function putAgentConfigFile(
  id: string,
  body: SetAgentConfigInput,
): Promise<AgentConfigFileContent> {
  return unwrap(
    await cez.api.v1.p[':projectId']['agent-config'][':id'].$put({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: body,
    }),
    `/agent-config/${encodeURIComponent(id)}`,
  )
}

/** The selected project's shared `context.yaml` and local `context.local.yaml` (hearsay-tools/squawk#4308, hearsay-tools/squawk#4341). */
export async function getSessionContext(opts: ReadOptions = {}): Promise<SessionContextState> {
  return unwrap(
    await cez.api.v1.p[':projectId']['session-context'].$get({ param: { projectId: queryScope() } }, init(opts)),
    '/session-context',
  )
}

/** Save `context.local.yaml` over the version the editor read; 409 on a newer disk version, 400 on problems. */
export async function putSessionContext(body: SetSessionContextInput): Promise<SessionContextState> {
  return unwrap(
    await cez.api.v1.p[':projectId']['session-context'].$put({ param: { projectId: queryScope() }, json: body }),
    '/session-context',
  )
}

/** Render a draft for one role without saving it. */
export async function postSessionContextPreview(body: SessionContextPreviewRequest, opts: ReadOptions = {}): Promise<SessionContextPreview> {
  return unwrap(
    await cez.api.v1.p[':projectId']['session-context'].preview.$post({ param: { projectId: queryScope() }, json: body }, init(opts)),
    '/session-context/preview',
  )
}

/** Chain-from-prompt: the planner proposes 1–5 steps for the task. Degraded answers come back
 *  as a one-step plan with `fallback: true`, never as an error — only transport/validation fail. */
export async function postPlan(task: string, agentProfile?: string | null): Promise<PlanResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].plan.$post({
      param: { projectId: queryScope() },
      json: { task, ...(agentProfile ? { agentProfile } : {}) },
    }),
    '/plan',
  )
}

/** Every automation with its runtime state, latest log row and tallies, plus the forge's
 *  availability and the scheduler summary — one read, the whole page. */
export async function getAutomations(opts?: ReadOptions & { archived?: 'include' | 'only' }): Promise<AutomationsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations.$get(
      // hearsay-tools/cezarion#1465: archived one-time schedules are left out unless asked for.
      { param: { projectId: opts?.projectId ?? queryScope() }, query: opts?.archived ? { archived: opts.archived } : {} },
      init(opts),
    ),
    '/automations',
  )
}

/** Create a definition. Always created PAUSED unless `enable` asks for a current-time baseline. */
export async function createAutomation(input: CreateAutomationInput): Promise<AutomationCreateResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/automations',
  )
}

/** Edit a definition. `expectedRevision` is the one the editor read — a stale one answers 409
 *  rather than overwriting an edit made elsewhere. */
export async function updateAutomation(
  id: string,
  input: UpdateAutomationInput,
): Promise<AutomationResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations[':id'].$put({
      // `hc` does not percent-encode a path param, so ids are pre-encoded at every call site.
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: input,
    }),
    `/automations/${encodeURIComponent(id)}`,
  )
}

/** Enable (from a current-time baseline — existing records never launch) or pause. Two routes,
 *  because they are two acts: only one of them establishes a baseline. */
export async function setAutomationEnabled(id: string, enabled: boolean): Promise<AutomationResponse> {
  const param = { projectId: queryScope(), id: encodeURIComponent(id) }
  const label = `/automations/${encodeURIComponent(id)}/${enabled ? 'enable' : 'pause'}`
  return unwrap(
    enabled
      ? await cez.api.v1.p[':projectId'].automations[':id'].enable.$post({ param })
      : await cez.api.v1.p[':projectId'].automations[':id'].pause.$post({ param }),
    label,
  )
}

/** Start a manual check (202) — `preview` counts matches and launches nothing, `execute` runs
 *  the poll for real. Poll `getAutomationCheck` with the returned id. */
export async function checkAutomation(
  id: string,
  mode: 'preview' | 'execute',
): Promise<AutomationCheckQueuedResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations[':id'].check.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { mode },
    }),
    `/automations/${encodeURIComponent(id)}/check`,
  )
}

/** Archive a one-time schedule without a task (hearsay-tools/cezarion#1465). Anything else is a 409. */
export async function cancelAutomation(id: string): Promise<AutomationResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations[':id'].cancel.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    `/automations/${encodeURIComponent(id)}/cancel`,
  )
}

/** Remove a definition (204). A missing id is a 404 `ApiError`. */
export async function deleteAutomation(id: string): Promise<void> {
  const res = await cez.api.v1.p[':projectId'].automations[':id'].$delete({
    param: { projectId: queryScope(), id: encodeURIComponent(id) },
  })
  if (!res.ok) throw errorFor(res.status, res.statusText, await res.text())
}

/** Fire a schedule once by hand (202): the run it created. Allowed while paused; leaves the
 *  schedule's next occurrence alone. A held lease or an unlaunchable project answers 409. */
export async function runAutomationNow(id: string): Promise<AutomationRunResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].automations[':id'].run.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    `/automations/${encodeURIComponent(id)}/run`,
  )
}

/** Relaunch a receipt whose task failed to start (`launch-error` log rows). */
export async function retryAutomationReceipt(receiptId: string): Promise<AutomationRetryResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['automation-log'][':receiptId'].retry.$post({
      param: { projectId: queryScope(), receiptId: encodeURIComponent(receiptId) },
    }),
    `/automation-log/${encodeURIComponent(receiptId)}/retry`,
  )
}

/** One manual check's progress. Workspace-level: the check registry is the server's, not a
 *  project's — the id is the whole address. */
export async function getAutomationCheck(id: string, opts?: ReadOptions): Promise<AutomationCheck> {
  return unwrap(
    await cez.api.v1['automation-checks'][':checkId'].$get(
      { param: { checkId: encodeURIComponent(id) } },
      init(opts),
    ),
    `/automation-checks/${encodeURIComponent(id)}`,
  )
}

/** One automation's execution log — newest first, capped server-side at 100 rows. */
export async function getAutomationLog(
  id: string,
  opts?: ReadOptions,
): Promise<AutomationLogResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['automation-log'].$get(
      { param: { projectId: queryScope() }, query: { automationId: id } },
      init(opts),
    ),
    `/automation-log?automationId=${encodeURIComponent(id)}`,
  )
}

/** Save an approved plan as a reusable chain. A 409 carries `exists: true` on the ApiError —
 *  ask the user, then retry with `overwrite: true`. */
export async function createWorkflow(input: SaveWorkflowInput): Promise<SaveWorkflowResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows.$post({
      param: { projectId: queryScope() },
      json: input,
    }),
    '/workflows',
  )
}

/** Import support for the builder (spec 012): the server parses + validates pasted workflow
 *  YAML (either form) and answers the normalized definition. */
export async function parseWorkflow(yaml: string): Promise<ParsedWorkflow> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows.parse.$post({
      param: { projectId: queryScope() },
      json: { yaml },
    }),
    '/workflows/parse',
  )
}

/** Delete a saved workflow file (spec 012 follow-up). Built-ins answer 400 — they have no
 *  file and always come back. */
export async function deleteWorkflow(name: string): Promise<DeleteWorkflowResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].workflows[':name'].$delete({
      param: { projectId: queryScope(), name: encodeURIComponent(name) },
    }),
    `/workflows/${encodeURIComponent(name)}`,
  )
}

/** The worktree management panel (#483): every materialized task worktree with disk usage,
 *  retention state, the total, and the current keep-limit. */
export async function getWorktrees(
  opts?: ReadOptions,
  /** For callers outside the routed view's scope (the shell's Git sidebar); else `queryScope()`. */
  projectId?: string,
): Promise<WorktreesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].worktrees.$get(
      { param: { projectId: projectId ?? queryScope() } },
      init(opts),
    ),
    '/worktrees',
  )
}

/** "Reclaim now": force the retention enforcer to reclaim over-limit finished worktrees
 *  (directory only — branch kept). Returns the reclaimed run ids. Always 200. */
export async function reclaimWorktrees(): Promise<ReclaimWorktreesResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].worktrees.reclaim.$post({
      param: { projectId: queryScope() },
      json: {},
    }),
    '/worktrees/reclaim',
  )
}

/** Cleanup's per-row Reclaim (issue 08 §B4): one finished run's worktree DIRECTORY, by
 *  retention's own rule. The branch is kept. 409 while the run is live or at review. */
export async function reclaimRunWorktree(runId: string): Promise<ReclaimWorktreeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].worktrees[':runId'].reclaim.$post({
      param: { projectId: queryScope(), runId: encodeURIComponent(runId) },
    }),
    `/worktrees/${encodeURIComponent(runId)}/reclaim`,
  )
}
