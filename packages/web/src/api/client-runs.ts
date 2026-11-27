import type { ProjectAddress, RunAddress } from './run-address'
import { defined } from '@open-mercato/cezar-api-client/contract/defined'
import type {
  ApiRun,
  ArchiveFinishedResponse,
  ArchiveFinishedScope,
  ArchivedRunsResponse,
  ArtifactMetadataResponse,
  AttachmentInput,
  CancelAutoResumeResponse,
  CancelResponse,
  ChangesPayload,
  ContinueResponse,
  CreatePrResponse,
  CreateRunInput,
  CreateRunResponse,
  DeleteRunResponse,
  EditQueuedMessageResponse,
  FileLinkResult,
  FilePreviewData,
  FinishResponse,
  GitCommitResponse,
  GitPushResponse,
  MarkAllReadResponse,
  MessageInput,
  MessageResponse,
  NotifyRunInput,
  OpenInCliResponse,
  OpenProjectInResponse,
  OpenTargetsResponse,
  PatchRunInput,
  PermissionDecision,
  PermissionDecisionResponse,
  PublishedArtifact,
  RemoveQueuedMessageResponse,
  RemoveWorktreeResponse,
  RepoCommitPayload,
  RunCommitsResponse,
  RunHistoryContext,
  RunHistoryPage,
  RunRecord,
  RunRelationships,
  RunSummary,
  Runner,
  RunsIndexResponse,
  RunsSearchResponse,
  WorktreeEntry,
} from '@open-mercato/cezar-api-client'
import { apiPath, queryScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import {
  runHistoryContextSchema,
  runHistoryPageSchema,
} from '@open-mercato/cezar-api-client/contract/events'
import { runRelationshipsSchema } from '@open-mercato/cezar-api-client/contract/delegation'
import {
  archivedRunsResponseSchema,
  runsSearchResponseSchema,
} from '@open-mercato/cezar-api-client/contract/runs'
import {
  cez,
  errorFor,
  init,
  requestText,
  runPath,
  unwrap,
  unwrapValidated,
  type ReadOptions,
} from './client-core'

/** The authoritative run list — slim summaries (#817), sorted newest-first by the server. Detail
 *  views read the full record through `getRun`. The window (#864): every unarchived run, plus the
 *  newest archived ones; older archived runs page in through `getArchivedRuns`. */
export async function getRuns(address: ProjectAddress, opts?: ReadOptions): Promise<RunSummary[]> {
  return unwrap(
    await cez.api.v1.p[':projectId']['run-summaries'].$get({ param: { projectId: address.projectId }, query: { archived: 'recent' } }, init(opts)),
    '/run-summaries',
  )
}

/** One page of the active project's archived runs past the run list's window, newest first
 *  (`GET /run-summaries/archived`, #864). `before` is the previous page's `nextCursor`. */
export async function getArchivedRuns(
  params: { before?: string | undefined; limit?: number | undefined; q?: string },
  opts?: ReadOptions,
): Promise<ArchivedRunsResponse> {
  const query = {
    ...(params.before !== undefined ? { before: params.before } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.q ? { q: params.q } : {}),
  }
  // Validated: the Archived tab and an issue's linked tasks merge these rows into their lists, so a
  // malformed body must be an error the view can show, never a crash.
  return unwrapValidated(
    await cez.api.v1.p[':projectId']['run-summaries'].archived.$get({ param: { projectId: queryScope() }, query }, init(opts)),
    '/run-summaries/archived', archivedRunsResponseSchema,
  )
}

/** The cross-project task index (`GET /api/v1/workspace/runs-index`) — what lets ⌘K find a task
 *  without knowing which project it lives in. Workspace-level like the registry, so it has no
 *  project-scoped spelling and never takes `queryScope()`. */
export async function getRunsIndex(opts?: ReadOptions): Promise<RunsIndexResponse> {
  return unwrap(await cez.api.v1.workspace['runs-index'].$get({}, init(opts)), '/workspace/runs-index')
}

/** Every project's root runs matching `q`, archived or not (`GET /workspace/runs-search`, #864):
 *  ⌘K's reach past each project's run-list window. Workspace-level, like the index. */
export async function searchRuns(q: string, opts?: ReadOptions): Promise<RunsSearchResponse> {
  // Validated: the palette spreads these rows into its list, so a malformed body must be an error.
  return unwrapValidated(await cez.api.v1.workspace['runs-search'].$get({ query: { q } }, init(opts)), '/workspace/runs-search', runsSearchResponseSchema)
}

export async function getRunRelationships(id: string, opts?: ReadOptions): Promise<RunRelationships> {
  return unwrapValidated(
    await cez.api.v1.p[':projectId'].runs[':id'].relationships.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) }, query: {} }, init(opts),
    ),
    `${runPath(id)}/relationships`, runRelationshipsSchema,
  )
}

/** Read the addressed project's full record; All tasks needs its steps, which the workspace index omits. */
export async function getRun({ projectId, runId: id }: RunAddress, opts?: ReadOptions): Promise<ApiRun> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$get(
      { param: { projectId, id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id),
  )
}

/** One reverse-paged history page. Validated (not merely cast) because `useRunHistory` iterates
 *  `events`: see `unwrapValidated`. */
export async function getRunHistory(
  id: string,
  cursor?: string,
  opts?: ReadOptions,
): Promise<RunHistoryPage> {
  return unwrapValidated(
    await cez.api.v1.p[':projectId'].runs[':id'].history.$get(
      {
        param: { projectId: queryScope(), id: encodeURIComponent(id) },
        query: { ...(cursor !== undefined ? { cursor } : {}) },
      },
      init(opts),
    ),
    `${runPath(id)}/history`,
    runHistoryPageSchema,
  )
}

/** The compact current-state context for a run. Validated for the same reason as the page above. */
export async function getRunHistoryContext(id: string, opts?: ReadOptions): Promise<RunHistoryContext> {
  return unwrapValidated(
    await cez.api.v1.p[':projectId'].runs[':id']['history-context'].$get(
      { param: { projectId: opts?.projectId ?? queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    `${runPath(id)}/history-context`,
    runHistoryContextSchema,
  )
}

/** A run's own commits (`<base>..HEAD`, newest first) for the task's Commits tab. */
export async function getRunCommits(id: string, opts?: ReadOptions): Promise<RunCommitsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].commits.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id, '/commits'),
  )
}

/** One of a run's commits, structured like the Changes tab. 409 for unknown shas. */
export async function getRunCommit(
  id: string,
  sha: string,
  opts?: ReadOptions,
): Promise<RepoCommitPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].commit[':sha'].$get(
      { param: { projectId: opts?.projectId ?? queryScope(), id: encodeURIComponent(id), sha: encodeURIComponent(sha) } },
      init(opts),
    ),
    runPath(id, `/commit/${encodeURIComponent(sha)}`),
  )
}

/** The run's worktree diff against its base, as unified-diff text. Also the plain-text
 *  "(no worktree — …)" sentence for runs that executed in the repo working tree. */
export async function getRunDiff(id: string, opts?: ReadOptions): Promise<string> {
  if (opts?.projectId !== undefined) {
    const res = await cez.api.v1.p[':projectId'].runs[':id'].diff.$get(
      { param: { projectId: opts.projectId, id: encodeURIComponent(id) } },
      { init: { ...defined({ signal: opts.signal }) }, headers: { accept: 'text/plain' } },
    )
    const body = await res.text()
    if (!res.ok) throw errorFor(res.status, res.statusText, body)
    return body
  }
  return requestText(runPath(id, '/diff'), { method: 'GET', ...defined({ signal: opts?.signal }) })
}

/** The journal: '' until seeded; only unknown runs 404. All tasks names its project to avoid the boot scope (hearsay-tools/cezarion#1616). */
export async function getRunHandoff({ projectId, runId: id }: RunAddress, opts?: ReadOptions): Promise<string> {
  const res = await cez.api.v1.p[':projectId'].runs[':id'].handoff.$get(
    { param: { projectId, id: encodeURIComponent(id) } },
    { init: { ...defined({ signal: opts?.signal }) }, headers: { accept: 'text/plain' } },
  )
  const body = await res.text()
  if (!res.ok) throw errorFor(res.status, res.statusText, body)
  return body
}

/** The run's structured working-directory-vs-base diff (R5): per-file status/±/patch + the
 *  aggregate stat. Worktree-off runs read the repo checkout they executed in. */
export async function getRunChanges(id: string, opts?: ReadOptions): Promise<ChangesPayload> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].changes.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) } },
      init(opts),
    ),
    runPath(id, '/changes'),
  )
}

/** One worktree path (R5 Files tab; also the Changes tab's expandable-context source):
 *  a directory listing, or a file with content unless binary/too large. */
export async function getRunFile(id: string, path: string, opts?: ReadOptions): Promise<WorktreeEntry> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].files.$get(
      { param: { projectId: queryScope(), id: encodeURIComponent(id) }, query: { path } },
      init(opts),
    ),
    '/runs/:id/files',
  )
}

export async function getFileLink(id: string, path: string, opts?: ReadOptions): Promise<FileLinkResult> {
  return unwrap(await cez.api.v1.p[':projectId'].runs[':id']['file-link'].$get(
    { param: { projectId: queryScope(), id }, query: { path } }, init(opts)), '/runs/:id/file-link')
}

export async function getArtifacts(id: string, opts?: ReadOptions): Promise<{ artifacts: PublishedArtifact[] }> {
  return unwrap(await cez.api.v1.p[':projectId'].runs[':id'].artifacts.$get(
    { param: { projectId: queryScope(), id } }, init(opts)), '/runs/:id/artifacts')
}

export async function getArtifact(id: string, artifactId: string, opts?: ReadOptions): Promise<FilePreviewData> {
  return unwrap(await cez.api.v1.p[':projectId'].runs[':id'].artifacts[':artifactId'].$get(
    { param: { projectId: queryScope(), id, artifactId } }, init(opts)), '/runs/:id/artifacts/:artifactId')
}

export async function getArtifactMetadata(id: string, artifactId: string, opts?: ReadOptions): Promise<ArtifactMetadataResponse> {
  return unwrap(await cez.api.v1.p[':projectId'].runs[':id'].artifacts[':artifactId'].metadata.$get(
    { param: { projectId: queryScope(), id, artifactId } }, init(opts)), '/runs/:id/artifacts/:artifactId/metadata')
}

export function artifactUrl(id: string, artifactId: string, representation: 'download' | 'image'): string {
  return apiPath(runPath(id, `/artifacts/${encodeURIComponent(artifactId)}/${representation}`))
}

export function fileLinkImageUrl(id: string, path: string): string {
  return apiPath(runPath(id, `/file-link?path=${encodeURIComponent(path)}&raw=1`))
}

/** Scoped same-origin `<img>` URL (not fetched): raw images within the size cap; otherwise 409. */
export function runFileRawUrl(id: string, path: string): string {
  return apiPath(runPath(id, `/files?path=${encodeURIComponent(path)}&raw=1`))
}

/** Hand a task to the project webhook, or stop notifying it (#589). The note goes to the
 *  webhook only, never into the agent session. */
export async function notifyRun(id: string, input: NotifyRunInput): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].notify.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: input,
    }),
    runPath(id, '/notify'),
  )
}

/** ×1 answers the run record; ×2/×3 answers `{ runs }` — narrow on `'runs' in result`. */
export async function createRun(input: CreateRunInput): Promise<CreateRunResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs.$post({ param: { projectId: queryScope() }, json: input }),
    '/runs',
  )
}

export async function cancelRun(id: string): Promise<CancelResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].cancel.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/cancel'),
  )
}

/** Archives by default; pass `false` to bring a run back into the live list. */
export async function archiveRun({ projectId, runId: id }: RunAddress, archived = true): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].archive.$post({
      param: { projectId, id: encodeURIComponent(id) },
      json: { archived },
    }),
    runPath(id, '/archive'),
  )
}

/** Pins by default; pass `false` to drop the task back into its ordinary bucket (#935). */
export async function pinRun({ projectId, runId: id }: RunAddress, pinned = true): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].pin.$post({
      param: { projectId, id: encodeURIComponent(id) },
      json: { pinned },
    }),
    runPath(id, '/pin'),
  )
}

/**
 * The read receipt in its addressed project, for the same
 * reason: the global Tasks page stands outside every `/p/:projectId`, so `queryScope()` would
 * stamp the receipt on the boot project. `read: false` is the inverse route (#775).
 */
export async function setRunRead(
  { projectId, runId: id }: RunAddress,
  read: boolean,
): Promise<RunRecord> {
  const route = read ? 'read' : 'unread'
  return unwrap(
    await (read
      ? cez.api.v1.p[':projectId'].runs[':id'].read.$post({
          param: { projectId, id: encodeURIComponent(id) },
        })
      : cez.api.v1.p[':projectId'].runs[':id'].unread.$post({
          param: { projectId, id: encodeURIComponent(id) },
        })),
    runPath(id, `/${route}`),
  )
}

/** Stop THIS task from resuming itself after a usage limit (spec
 *  2026-08-03-auto-resume-after-usage-limit) — the per-task twin of the workspace setting.
 *  Idempotent: a task with nothing scheduled answers the same way. */
export async function cancelAutoResume(id: string): Promise<CancelAutoResumeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['auto-resume'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/auto-resume'),
  )
}

/** Sweep finished runs into the archive in one call — the Tasks header's "Archive finished"
 *  button (no scope) or one sidebar group (`unpinned` / `pinned`). What it takes is
 *  the contract's `isSweepable` (`run-predicates`): owned workers are skipped. */
export async function archiveFinished(
  { projectId }: ProjectAddress,
  scope?: ArchiveFinishedScope,
  automation?: boolean,
): Promise<ArchiveFinishedResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs['archive-finished'].$post({
      param: { projectId },
      json: { ...(scope ? { scope } : {}), ...(automation !== undefined ? { automation } : {}) },
    }),
    '/runs/archive-finished',
  )
}

/** "Mark all read": stamp every currently-unread finished run in one call. */
export async function markAllRunsSeen(automation?: boolean): Promise<MarkAllReadResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs['read-all'].$post({
      param: { projectId: queryScope() },
      // `automation` narrows the sweep to one origin (hearsay-tools/cezarion#1616); absent is all.
      json: automation !== undefined ? { automation } : {},
    }),
    '/runs/read-all',
  )
}

/** Close a waiting session gracefully — the run completes as done. 409 when nothing is open. */
export async function finishRun(id: string, projectId?: string): Promise<FinishResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].finish.$post({
      param: { projectId: projectId ?? queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/finish'),
  )
}

/** The follow-up composer's optional overrides for a Continue (#401): pick which backend, model
 *  and agent account handle the reopened session. Omitted fields keep the run's current
 *  backend/model/account. `text`/`images` are the prompt the reopened session starts on — omitted,
 *  the engine opens with its plain "Continue.". */
export interface ContinueOptions {
  text?: string | undefined
  images?: AttachmentInput[] | undefined
  runner?: Runner | undefined
  model?: string | undefined
  /** Reasoning-effort pin (#45). Omitted keeps the run's pin; empty string clears it. */
  effort?: string | undefined
  /** Which login of that agent reopens it (spec 2026-07-29-agent-profiles). Switching account
   *  starts a fresh session server-side — a session id lives inside ONE account's config dir. */
  agentProfile?: string | undefined
}

/** Reopen a finished run's session. 409 (with the reason) when it cannot be resumed. An optional
 *  runner/model override lets the follow-up choose the engine; omitted keeps the run's current
 *  backend (backward compat). */
export async function continueRun({ projectId, runId: id }: RunAddress, opts: ContinueOptions = {}): Promise<ContinueResponse> {
  const body = {
    ...(opts.text !== undefined ? { text: opts.text } : {}),
    ...(opts.images !== undefined ? { images: opts.images } : {}),
    ...(opts.runner !== undefined ? { runner: opts.runner } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
    ...(opts.agentProfile !== undefined ? { agentProfile: opts.agentProfile } : {}),
  }
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].continue.$post({
      param: { projectId, id: encodeURIComponent(id) },
      json: body,
    }),
    runPath(id, '/continue'),
  )
}

/** Draft PR from the review gate (spec 009): push the branch, `gh pr create --draft`; the run
 *  completes as done with the PR badge. On 409 the ApiError's `manual` carries the
 *  `git merge <branch>` fallback to show copyable. */
export async function createRunPr(id: string, projectId?: string): Promise<CreatePrResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].pr.$post({
      param: { projectId: projectId ?? queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/pr'),
  )
}

/** Edit a run's title or completion settings through the shared PATCH contract. */
export async function patchRun(id: string, patch: PatchRunInput): Promise<RunRecord> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$patch({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: patch,
    }),
    runPath(id),
  )
}

/** Deletes the run, its transcript, its worktree and its branch. 409 while it is still active. */
export async function deleteRun(id: string): Promise<DeleteRunResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id),
  )
}

/** Hand the session off to a real terminal (spec 003), in the run's worktree when it still
 *  exists. On 409 the ApiError's `command` carries the manual `cd … && <resume>` to copy. */
export async function openRunInCli(id: string): Promise<OpenInCliResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['open-in-cli'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/open-in-cli'),
  )
}

/** The local editors / file-manager / terminal this machine can open a worktree in (#open-in).
 *  Empty in hosted mode (CEZ_REMOTE). */
export async function getOpenTargets(opts?: ReadOptions): Promise<OpenTargetsResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['open-targets'].$get(
      { param: { projectId: queryScope() } },
      init(opts),
    ),
    '/open-targets',
  )
}

/** Open the ACTIVE PROJECT's own folder in the chosen local app (Settings → "Project folder").
 *  No path travels: the server opens the scoped project's registered root. 400 for an app this
 *  machine does not have or a `cli:` handoff, 409 in hosted mode or when the launch failed. */
export async function openProjectIn(target: string, projectId = queryScope()): Promise<OpenProjectInResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId']['open-in'].$post({
      param: { projectId },
      json: { target },
    }),
    '/open-in',
  )
}

/** Open the run's worktree in the chosen local app. 409 with `path` when it could not launch. */
export async function openRunIn(
  id: string,
  target: string,
): Promise<{ opened: boolean; path: string }> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['open-in'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { target },
    }),
    runPath(id, '/open-in'),
  )
}

/** Diff pane "open in default app" (#365, LOCAL MODE ONLY): opens one worktree file with the
 *  OS's default handler for its type — not the file manager, a specific file. 409 (server's own
 *  words) in hosted mode, for a path outside the worktree, or when no app could be launched. */
export async function openRunFileInApp(
  id: string,
  path: string,
): Promise<{ opened: boolean; path: string }> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['open-in'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { target: 'default', path },
    }),
    runPath(id, '/open-in'),
  )
}

/** `git add -A && git commit` in the run's worktree (R5). Every predictable git failure —
 *  clean tree, failing hook, missing identity — is a 409 whose ApiError speaks git's words. */
export async function commitRun(id: string, message: string): Promise<GitCommitResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].git.commit.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: { message },
    }),
    runPath(id, '/git/commit'),
  )
}

/** Push the worktree's branch, setting upstream when it has none (R5). No remote, detached
 *  HEAD and rejected pushes all come back as 409 + reason. */
export async function pushRun(id: string): Promise<GitPushResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].git.push.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/git/push'),
  )
}

/** Deliver one native approval choice. An expired request must never become a new turn. */
export async function decidePermission(id: string, decision: PermissionDecision): Promise<PermissionDecisionResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].permissions.$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
      json: decision,
    }),
    runPath(id, '/permissions'),
  )
}

/** Deliver text and/or pasted screenshots into a run's live session. 409 once it has closed. */
export async function sendMessage({ projectId, runId: id }: RunAddress, message: MessageInput): Promise<MessageResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id'].messages.$post({
      param: { projectId, id: encodeURIComponent(id) },
      json: { text: message.text ?? '', images: message.images ?? [] },
    }),
    runPath(id, '/messages'),
  )
}

/** Replace a stacked message on a still-queued run (#472). 404 unknown run/message,
 *  409 once the run has started. */
export async function editQueuedMessage(
  id: string,
  msgId: string,
  message: MessageInput,
): Promise<EditQueuedMessageResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['queued-messages'][':msgId'].$patch({
      param: { projectId: queryScope(), id: encodeURIComponent(id), msgId: encodeURIComponent(msgId) },
      json: message,
    }),
    runPath(id, `/queued-messages/${encodeURIComponent(msgId)}`),
  )
}

/** Drop a stacked message from a still-queued run (#472). */
export async function removeQueuedMessage(
  id: string,
  msgId: string,
): Promise<RemoveQueuedMessageResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['queued-messages'][':msgId'].$delete({
      param: { projectId: queryScope(), id: encodeURIComponent(id), msgId: encodeURIComponent(msgId) },
    }),
    runPath(id, `/queued-messages/${encodeURIComponent(msgId)}`),
  )
}

/** Per-row "Delete" in the worktrees panel: reclaim one run's worktree AND its branch
 *  (the existing spec-006 route). 409 while the run is active. */
export async function removeRunWorktree(id: string): Promise<RemoveWorktreeResponse> {
  return unwrap(
    await cez.api.v1.p[':projectId'].runs[':id']['remove-worktree'].$post({
      param: { projectId: queryScope(), id: encodeURIComponent(id) },
    }),
    runPath(id, '/remove-worktree'),
  )
}
