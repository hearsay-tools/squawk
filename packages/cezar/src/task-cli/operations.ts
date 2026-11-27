import { randomUUID } from 'node:crypto';
import {
  apiRunSchema,
  archiveFinishedResponseSchema,
  cancelResponseSchema,
  finishResponseSchema,
  messageResponseSchema,
  runRecordSchema,
  type ApiRun,
  type RunRecord,
  type RunSummary,
} from '@open-mercato/cezar-contract/runs';
import { changesPayloadSchema } from '@open-mercato/cezar-contract/repo';
import { pendingAskOf, type PendingAsk } from '@open-mercato/cezar-contract/pending-ask';
import { asksQuestion } from '@open-mercato/cezar-contract/waiting-on';
import { runHistoryContextSchema } from '@open-mercato/cezar-contract/events';
import { projectsResponseSchema } from '@open-mercato/cezar-contract/projects';
import { runnerSkillListSchema } from '@open-mercato/cezar-contract/runner-skills';
import { runnerSchema } from '@open-mercato/cezar-contract/runner';
import { runnersResponseSchema } from '@open-mercato/cezar-contract/runners';
import { runsIndexResponseSchema } from '@open-mercato/cezar-contract/workspace-events';
import { commandText } from '../home/command.ts';
import { skillFlagIssue, skillTaskSteps } from '../workflows/types.ts';
import {
  cockpitForProject,
  fetchJson,
  handoffUrl,
  invalidResponse,
  refuse,
  request,
  TaskCliError,
  threadUrl,
  type Cockpit,
  type FetchFn,
} from './http.ts';
import { projectListRow, projectStatus } from './projections.ts';
import {
  readLogSnapshot,
  requestRunSummaries,
  waitForRuns,
  type LogSnapshot,
  type WaitEntry,
  type WaitMode,
  type WaitResult,
  type WaitUntil,
} from './watch.ts';

/**
 * Shared typed task operations behind both `hsq task` and `hsq mcp` (spec
 * 2026-11-27-orchestrator-mcp-server). Every function returns plain JSON data and throws
 * `TaskCliError` on refusals or invalid responses; none writes stdout or exits the process.
 */

export const DEFAULT_HANDOFF_MAX_CHARS = 16_000;
export const DEFAULT_DIFF_MAX_CHARS = 32_000;

export interface ProjectSummary {
  id: string;
  name: string;
  status: 'ok' | 'missing' | 'not-git';
  branch?: string | undefined;
  repoUrl?: string | undefined;
  tags?: string[] | undefined;
}

export interface TransportOptions {
  fetch?: FetchFn | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * List registered projects from `GET /api/v1/projects`, stripping host-only paths (`root`,
 * `projectsDir`), `bootProject`, and `webhooks`.
 */
export async function listProjects(origin: string, options: TransportOptions = {}): Promise<{ projects: ProjectSummary[] }> {
  const result = await fetchJson(`${origin}/api/v1/projects`, {
    fetch: options.fetch,
    signal: options.signal,
  });
  if (result.status !== 200) refuse(result);
  const parsed = projectsResponseSchema.safeParse(result.data);
  if (!parsed.success) invalidResponse('projects');
  const projects: ProjectSummary[] = parsed.data.projects.map((entry) => ({
    id: entry.id,
    name: entry.name,
    status: entry.status,
    ...(entry.branch !== undefined ? { branch: entry.branch } : {}),
    ...(entry.repoUrl !== undefined ? { repoUrl: entry.repoUrl } : {}),
    ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
  }));
  return { projects };
}

/**
 * Validate `projectId` against live `GET /api/v1/projects` and build its scoped `Cockpit`.
 * Never falls back to `bootProject`.
 */
export async function resolveProjectCockpit(
  origin: string,
  projectId: string,
  options: TransportOptions = {},
): Promise<Cockpit> {
  const trimmed = projectId.trim();
  if (!trimmed) {
    throw new TaskCliError(64, {
      code: 'invalid_input',
      error: 'project is required',
      hint: 'call project_list to see available project IDs',
    });
  }
  const { projects } = await listProjects(origin, options);
  if (!projects.some((entry) => entry.id === trimmed)) {
    const available = projects.map((entry) => entry.id);
    throw new TaskCliError(2, {
      code: 'unknown_project',
      error: `unknown project '${trimmed}'`,
      hint: available.length > 0 ? `available projects: ${available.join(', ')}` : 'no projects are registered on this cockpit',
    });
  }
  return cockpitForProject(origin, trimmed, options.fetch);
}

export async function getRun(cockpit: Cockpit, id: string, signal?: AbortSignal): Promise<ApiRun> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}`, { signal });
  if (result.status !== 200) refuse(result);
  const run = apiRunSchema.safeParse(result.data);
  return run.success ? run.data : invalidResponse('run');
}

/** `list --full` prints contract `ApiRun` rows, so it alone still reads every full record. */
export async function listRuns(cockpit: Cockpit, signal?: AbortSignal): Promise<ApiRun[]> {
  const result = await request(cockpit, '/runs', { signal });
  if (result.status !== 200) refuse(result);
  const runs = apiRunSchema.array().safeParse(result.data);
  return runs.success ? runs.data : invalidResponse('run list');
}

/**
 * Workers are steer targets of their parent, not tasks ops follows (#635): the list leaves them
 * out, and subscribing one to the webhook is refused with the parent to subscribe instead. Every
 * other id-addressed operation still reaches a worker.
 */
export function workerParent(run: Pick<ApiRun, 'delegation'> | Pick<RunSummary, 'delegation'>): string | undefined {
  return run.delegation?.role === 'worker' ? run.delegation.parentRunId : undefined;
}

/** The latest valid unanswered question, from the same derivation the cockpit renders. */
export async function pendingQuestion(cockpit: Cockpit, id: string, signal?: AbortSignal): Promise<PendingAsk | undefined> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}/history-context`, { signal });
  const context = runHistoryContextSchema.safeParse(result.data);
  return result.status === 200 && context.success ? pendingAskOf(context.data.contextEvents) : undefined;
}

/**
 * The project's default runner as the server runs it. A stored id no runner registered names the
 * first registered runner, as the server's `resolveRunnerId` does (hearsay-tools/squawk#4200). When
 * the runners list cannot be read, the stored id is used as it is.
 */
async function defaultRunnerFor(cockpit: Cockpit, signal?: AbortSignal): Promise<string | undefined> {
  const config = await request(cockpit, '/config', { signal });
  const stored = config.status === 200 && config.data && typeof config.data === 'object'
    ? runnerSchema.safeParse(Reflect.get(config.data, 'defaultRunner'))
    : undefined;
  if (!stored?.success) return undefined;
  const runners = await fetchJson(`${cockpit.origin}/api/v1/runners`, { fetch: cockpit.fetch, signal });
  const registered = runners.status === 200 ? runnersResponseSchema.safeParse(runners.data) : undefined;
  if (!registered?.success) return stored.data;
  const ids = registered.data.runners.map((entry) => entry.id);
  return ids.includes(stored.data) ? stored.data : ids[0] ?? stored.data;
}

async function skillWarning(cockpit: Cockpit, skill: string, runner: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
  // Discovery is advisory: the catalog can change before a queued run executes. The server
  // fails a step with a missing skill, and idempotent retries still go to POST /runs.
  const unverified = `could not check whether skill "${skill}" is available; a missing id fails the step`;
  try {
    const selectedRunner = runner ?? await defaultRunnerFor(cockpit, signal);
    const catalog = selectedRunner ? await request(cockpit, `/runner-skills?runner=${encodeURIComponent(selectedRunner)}`, { signal }) : undefined;
    if (catalog?.status === 200) {
      const skills = runnerSkillListSchema.safeParse(catalog.data);
      if (!skills.success) return unverified;
      return skills.data.skills.some((entry) => entry.id === skill)
        ? undefined
        : `skill "${skill}" is not currently available; a missing id fails the step`;
    }
    return unverified;
  } catch {
    return unverified;
  }
}

export interface StartTaskInput {
  task: string;
  requestId?: string | undefined;
  workflow?: string | undefined;
  skill?: string | undefined;
  runner?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  autonomous?: boolean | undefined;
  worktree?: boolean | undefined;
  allowWorkers?: boolean | undefined;
  allowMessaging?: boolean | undefined;
  archiveWhenDone?: boolean | undefined;
  autoMergePr?: boolean | undefined;
  notify?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export interface StartTaskResult {
  id: string;
  url: string;
  status: RunRecord['status'];
  created: boolean;
  requestId: string;
  notify: boolean;
  warning: string | undefined;
  branch: string | undefined;
}

export async function startTask(cockpit: Cockpit, input: StartTaskInput): Promise<StartTaskResult> {
  const skillIssue = skillFlagIssue({ skill: input.skill, workflow: input.workflow });
  if (skillIssue) throw new TaskCliError(64, { code: 'invalid_input', error: skillIssue });
  const requestId = input.requestId ?? randomUUID();
  const warning = input.skill === undefined ? undefined : await skillWarning(cockpit, input.skill, input.runner, input.signal);
  const result = await request(cockpit, '/runs', {
    signal: input.signal,
    body: {
      task: input.task,
      ...(input.skill === undefined
        ? { workflow: input.workflow ?? 'quick-task' }
        : { steps: skillTaskSteps(input.skill) }),
      ...(input.runner !== undefined ? { runner: input.runner } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.autonomous !== undefined ? { autonomous: input.autonomous } : {}),
      ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
      ...(input.allowWorkers !== undefined ? { allowWorkers: input.allowWorkers } : {}),
      ...(input.allowMessaging !== undefined ? { allowMessaging: input.allowMessaging } : {}),
      ...(input.archiveWhenDone !== undefined ? { archiveWhenDone: input.archiveWhenDone } : {}),
      ...(input.autoMergePr !== undefined ? { autoMergePr: input.autoMergePr } : {}),
      ...(input.notify !== undefined ? { notify: input.notify } : {}),
      clientRequestId: requestId,
    },
  });
  if (result.status !== 200 && result.status !== 201) refuse(result);
  const run = runRecordSchema.safeParse(result.data);
  if (!run.success) invalidResponse('start');
  return {
    id: run.data.id,
    url: threadUrl(cockpit, run.data.id),
    status: run.data.status,
    created: result.status === 201,
    requestId,
    notify: run.data.notify === true,
    warning,
    branch: run.data.branch,
  };
}

export async function setTaskNotify(cockpit: Cockpit, id: string, notify: boolean, message: string | undefined, signal?: AbortSignal): Promise<RunRecord> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}/notify`, {
    signal,
    body: { notify, message },
  });
  if (result.status !== 200) refuse(result);
  const run = runRecordSchema.safeParse(result.data);
  return run.success ? run.data : invalidResponse('notify');
}

export interface SendTaskMessageInput {
  id: string;
  text: string;
  resume?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

export type TaskMessageDelivery = 'delivered' | 'queued' | 'deferred' | 'resumed' | 'not-delivered';

export interface SendTaskMessageResult {
  id: string;
  delivery: TaskMessageDelivery;
  reason?: string | undefined;
  next?: string | undefined;
  hint?: string | undefined;
}

export async function sendTaskMessage(
  cockpit: Cockpit,
  input: SendTaskMessageInput,
  options: { closedHintStyle?: 'cli' | 'mcp' } = {},
): Promise<SendTaskMessageResult> {
  const path = `/runs/${encodeURIComponent(input.id)}`;
  const delivered = await request(cockpit, `${path}/messages`, { signal: input.signal, body: { text: input.text } });
  if (delivered.status === 200) {
    const answer = messageResponseSchema.safeParse(delivered.data);
    if (!answer.success) invalidResponse('message');
    const delivery = 'delivered' in answer.data ? 'delivered' : 'queued' in answer.data ? 'queued' : 'deferred';
    return { id: input.id, delivery };
  }
  const closed = delivered.status === 409 && (delivered.data as { error?: unknown } | undefined)?.error === 'session closed';
  if (!closed) refuse(delivered);
  if (!input.resume) {
    if (options.closedHintStyle === 'mcp') {
      return {
        id: input.id,
        delivery: 'not-delivered',
        reason: 'session closed',
        hint: 'retry task_send with resume: true to reopen the settled session',
      };
    }
    return {
      id: input.id,
      delivery: 'not-delivered',
      reason: 'session closed',
      next: commandText(`cez task send ${input.id} '…' --resume`),
    };
  }
  const resumed = await request(cockpit, `${path}/continue`, { signal: input.signal, body: { text: input.text } });
  if (resumed.status !== 200) refuse(resumed);
  return { id: input.id, delivery: 'resumed' };
}

export interface GetTaskStatusInput {
  id: string;
  full?: boolean | undefined;
  includeHandoff?: boolean | undefined;
  maxChars?: number | undefined;
  signal?: AbortSignal | undefined;
}

async function readBoundedHandoff(
  cockpit: Cockpit,
  id: string,
  maxChars: number,
  signal?: AbortSignal,
): Promise<{ handoff: string; handoffTruncated?: true }> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}/handoff`, { signal });
  if (result.status !== 200) refuse(result);
  if (typeof result.data !== 'string') invalidResponse('handoff');
  if (result.data.length > maxChars) {
    return { handoff: result.data.slice(0, maxChars), handoffTruncated: true };
  }
  return { handoff: result.data };
}

export async function getTaskStatus(cockpit: Cockpit, input: GetTaskStatusInput): Promise<Record<string, unknown>> {
  const run = await getRun(cockpit, input.id, input.signal);
  const handoffFields = input.includeHandoff
    ? await readBoundedHandoff(cockpit, input.id, input.maxChars ?? DEFAULT_HANDOFF_MAX_CHARS, input.signal)
    : undefined;
  if (input.full) {
    return handoffFields ? { ...run, ...handoffFields } : { ...run };
  }
  const question = asksQuestion(run) ? await pendingQuestion(cockpit, input.id, input.signal) : undefined;
  return {
    ...projectStatus(run, threadUrl(cockpit, input.id), question),
    handoffUrl: handoffUrl(cockpit, input.id),
    ...handoffFields,
  };
}

export interface GetTaskLogInput {
  id: string;
  since?: number | undefined;
  maxChars?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export async function getTaskLog(cockpit: Cockpit, input: GetTaskLogInput): Promise<LogSnapshot & { id: string }> {
  const snapshot = await readLogSnapshot(cockpit, input.id, {
    afterSeq: input.since ?? 0,
    maxChars: input.maxChars ?? 8_000,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  });
  return { id: input.id, ...snapshot };
}

export interface GetTaskDiffInput {
  id: string;
  stat?: boolean | undefined;
  maxChars?: number | undefined;
  signal?: AbortSignal | undefined;
}

export async function getTaskDiff(cockpit: Cockpit, input: GetTaskDiffInput): Promise<Record<string, unknown>> {
  const path = `/runs/${encodeURIComponent(input.id)}`;
  if (input.stat) {
    const result = await request(cockpit, `${path}/changes`, { signal: input.signal });
    if (result.status !== 200) refuse(result);
    const changes = changesPayloadSchema.safeParse(result.data);
    if (!changes.success) invalidResponse('changes');
    return {
      id: input.id,
      stat: changes.data.stat,
      files: changes.data.files.map((file) => ({ path: file.path, status: file.status, adds: file.adds, dels: file.dels })),
    };
  }
  const result = await request(cockpit, `${path}/diff`, { signal: input.signal });
  if (result.status !== 200) refuse(result);
  if (typeof result.data !== 'string') invalidResponse('diff');
  if (input.maxChars === undefined) return { id: input.id, diff: result.data };
  const truncated = result.data.length > input.maxChars;
  return {
    id: input.id,
    diff: truncated ? result.data.slice(0, input.maxChars) : result.data,
    truncated,
  };
}

export interface WaitForTasksInput {
  ids: string[];
  mode: WaitMode;
  until: WaitUntil;
  timeoutMs: number;
  pollMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onHeartbeat?: ((elapsedMs: number, entries: readonly WaitEntry[]) => void | Promise<void>) | undefined;
  heartbeatMs?: number | undefined;
}

export function waitForTasks(cockpit: Cockpit, input: WaitForTasksInput): Promise<WaitResult> {
  return waitForRuns(cockpit, input.ids, {
    mode: input.mode,
    until: input.until,
    timeoutMs: input.timeoutMs,
    pollMs: input.pollMs,
    signal: input.signal,
    onHeartbeat: input.onHeartbeat,
    heartbeatMs: input.heartbeatMs,
  });
}

export async function stopTask(cockpit: Cockpit, id: string, signal?: AbortSignal): Promise<{ id: string; cancelled: boolean }> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}/cancel`, { signal, body: {} });
  const answer = cancelResponseSchema.safeParse(result.data);
  if (result.status !== 200) refuse(result);
  if (!answer.success) invalidResponse('cancel');
  return { id, cancelled: answer.data.cancelled };
}

export async function finishTask(cockpit: Cockpit, id: string, signal?: AbortSignal): Promise<{ id: string; finished: true }> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}/finish`, { signal, body: {} });
  if (result.status !== 200) refuse(result);
  if (!finishResponseSchema.safeParse(result.data).success) invalidResponse('finish');
  return { id, finished: true };
}

export async function archiveTask(
  cockpit: Cockpit,
  id: string,
  archived: boolean,
  signal?: AbortSignal,
): Promise<{ id: string; archived: boolean }> {
  const result = await request(cockpit, `/runs/${encodeURIComponent(id)}/archive`, { signal, body: { archived } });
  if (result.status !== 200) refuse(result);
  const run = runRecordSchema.safeParse(result.data);
  if (!run.success) invalidResponse('archive');
  return { id: run.data.id, archived: run.data.archived === true };
}

export async function archiveFinishedTasks(cockpit: Cockpit, signal?: AbortSignal) {
  const result = await request(cockpit, '/runs/archive-finished', { method: 'POST', signal });
  if (result.status !== 200) refuse(result);
  const answer = archiveFinishedResponseSchema.safeParse(result.data);
  if (!answer.success) invalidResponse('archive-finished');
  return answer.data;
}

export interface ListTasksInput {
  statuses?: ReadonlySet<string> | undefined;
  limit: number;
  all?: boolean | undefined;
  full?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

function filterAndSortRuns<T extends Pick<RunSummary, 'delegation' | 'archived' | 'status' | 'createdAt'>>(
  runs: readonly T[],
  input: Pick<ListTasksInput, 'all' | 'statuses'>,
): T[] {
  return runs
    .filter((run) => workerParent(run) === undefined)
    .filter((run) => input.all || !run.archived)
    .filter((run) => !input.statuses || input.statuses.has(run.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listTasks(cockpit: Cockpit, input: ListTasksInput): Promise<{ runs: unknown[]; total: number }> {
  const summaries = () => requestRunSummaries(cockpit, undefined, {
    ...(input.all ? {} : { archived: 'recent' }),
    signal: input.signal,
  });
  const runs = input.full
    ? filterAndSortRuns(await listRuns(cockpit, input.signal), input)
    : filterAndSortRuns(await summaries(), input);
  return {
    runs: runs.slice(0, input.limit).map((run) => (input.full ? run : projectListRow(run))),
    total: runs.length,
  };
}

export async function listAllProjectsTasks(
  origin: string,
  input: ListTasksInput & { fetch?: FetchFn | undefined },
): Promise<{ project: 'all'; total: number; runs: unknown[] }> {
  const result = await fetchJson(`${origin}/api/v1/workspace/runs-index`, {
    fetch: input.fetch,
    signal: input.signal,
    responseLimitBytes: Infinity,
  });
  if (result.status !== 200) refuse(result);
  const parsed = runsIndexResponseSchema.safeParse(result.data);
  if (!parsed.success) invalidResponse('runs-index');
  const filtered = filterAndSortRuns(parsed.data.runs, input);
  const runs = filtered.slice(0, input.limit).map((run) => (
    input.full
      ? { project: run.projectId, ...run }
      : { project: run.projectId, ...projectListRow(run) }
  ));
  return { project: 'all', total: filtered.length, runs };
}
