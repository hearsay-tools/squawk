import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { runStatusSchema } from '@open-mercato/cezar-contract/runs';
import { z } from 'zod';
import { TaskCliError, type FetchFn } from '../../task-cli/http.ts';
import {
  archiveTask,
  DEFAULT_DIFF_MAX_CHARS,
  DEFAULT_HANDOFF_MAX_CHARS,
  finishTask,
  getTaskDiff,
  getTaskLog,
  getTaskStatus,
  listAllProjectsTasks,
  listProjects,
  listTasks,
  resolveProjectCockpit,
  sendTaskMessage,
  startTask,
  stopTask,
  waitForTasks,
} from '../../task-cli/operations.ts';
import type { WaitEntry } from '../../task-cli/watch.ts';

const TASK_TEXT_MAX_CHARS = 100_000;
const MAX_BOUNDED_CHARS = 200_000;
const MAX_LOG_CHARS = 1_000_000;
const DEFAULT_WAIT_TIMEOUT_SECONDS = 120;
const MAX_WAIT_TIMEOUT_SECONDS = 1_800;
const DEFAULT_HEARTBEAT_MS = 15_000;
const STATUS_LIST = runStatusSchema.options.join(', ');

export const MCP_SERVER_NAME = 'squawk';

export const MCP_SERVER_INSTRUCTIONS = [
  'Squawk MCP server — manage coding agent tasks on a running Squawk cockpit.',
  '1. Call project_list first to discover registered project IDs.',
  '2. Pass `project` explicitly to every task_* tool (`task_list` also accepts "all"). There is no default project.',
  '3. Read `attention` and `attentionLabel` (derived by the cockpit) to see when a task needs input:',
  '   - `waiting` ("needs you" / "needs review"), `error`, or `permission` means the task needs you.',
  '   - `running` ("waiting for CI", "waiting for merge", "monitoring") or `none` ("waiting on N workers", usage-limit hold) means the task is still progressing on its own.',
  '4. Use task_wait (default mode "any", until "attention") to wait efficiently without tight polling.',
].join('\n');

const nonEmptyString = z.string().trim().min(1);
const boundedText = z.string().refine((value) => value.trim().length > 0, 'must not be empty').pipe(z.string().max(TASK_TEXT_MAX_CHARS));

const projectListInputSchema = z.object({}).strict();

const taskStartInputSchema = z.object({
  project: nonEmptyString,
  task: boundedText,
  requestId: nonEmptyString.optional(),
  workflow: nonEmptyString.optional(),
  skill: nonEmptyString.optional(),
  runner: nonEmptyString.optional(),
  model: nonEmptyString.optional(),
  effort: nonEmptyString.optional(),
  autonomous: z.boolean().optional(),
  worktree: z.boolean().optional(),
  allowWorkers: z.boolean().optional(),
  allowMessaging: z.boolean().optional(),
  archiveWhenDone: z.boolean().optional(),
  autoMergePr: z.boolean().optional(),
}).strict();

const taskSendInputSchema = z.object({
  project: nonEmptyString,
  id: nonEmptyString,
  text: boundedText,
  resume: z.boolean().optional(),
}).strict();

const taskStatusInputSchema = z.object({
  project: nonEmptyString,
  id: nonEmptyString,
  full: z.boolean().optional(),
  includeHandoff: z.boolean().optional(),
  maxChars: z.number().int().min(1).max(MAX_BOUNDED_CHARS).optional(),
}).strict();

const taskLogInputSchema = z.object({
  project: nonEmptyString,
  id: nonEmptyString,
  since: z.number().int().min(0).optional(),
  maxChars: z.number().int().min(1).max(MAX_LOG_CHARS).optional(),
}).strict();

const taskDiffInputSchema = z.object({
  project: nonEmptyString,
  id: nonEmptyString,
  stat: z.boolean().optional(),
  maxChars: z.number().int().min(1).max(MAX_BOUNDED_CHARS).optional(),
}).strict();

const taskWaitInputSchema = z.object({
  project: nonEmptyString,
  ids: z.array(nonEmptyString).min(1).max(32),
  mode: z.enum(['any', 'all']).optional(),
  until: z.enum(['attention', 'settled']).optional(),
  timeoutSeconds: z.number().int().min(1).max(MAX_WAIT_TIMEOUT_SECONDS).optional(),
}).strict();

const taskIdInputSchema = z.object({
  project: nonEmptyString,
  id: nonEmptyString,
}).strict();

const taskListInputSchema = z.object({
  project: nonEmptyString,
  status: z.union([z.string(), z.array(runStatusSchema)]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  all: z.boolean().optional(),
  full: z.boolean().optional(),
}).strict();

function parseStatusFilter(value: string | readonly string[] | undefined): Set<string> | undefined {
  if (value === undefined) return undefined;
  const entries = typeof value === 'string'
    ? value.split(',').map((item) => item.trim()).filter(Boolean)
    : [...value];
  if (entries.length === 0) return undefined;
  const invalid = entries.find((item) => !runStatusSchema.safeParse(item).success);
  if (invalid) {
    throw new TaskCliError(64, { code: 'invalid_input', error: `unknown status '${invalid}'; one of ${STATUS_LIST}` });
  }
  return new Set(entries);
}

export interface OrchestratorMcpOptions {
  origin: string;
  version?: string | undefined;
  fetch?: FetchFn | undefined;
  pollMs?: number | undefined;
  heartbeatMs?: number | undefined;
  /** When set (project-scoped bearer token), restricts `project_list` and rejects all other projects. */
  allowedProject?: string | undefined;
  /** Optional external abort signal (such as HTTP client disconnect) combined with MCP `extra.signal`. */
  requestSignal?: AbortSignal | undefined;
}

interface ToolCallContext {
  origin: string;
  fetch?: FetchFn | undefined;
  pollMs?: number | undefined;
  heartbeatMs?: number | undefined;
  allowedProject?: string | undefined;
  signal: AbortSignal;
  sendProgress?: ((progress: number, total: number, message: string) => Promise<void>) | undefined;
}

function assertAllowedProject(project: string, ctx: ToolCallContext): void {
  if (ctx.allowedProject !== undefined && (project === 'all' || project !== ctx.allowedProject)) {
    throw new TaskCliError(2, {
      code: 'forbidden',
      error: `bearer token is scoped to project '${ctx.allowedProject}' and cannot access '${project}'`,
    });
  }
}

interface ToolEntry {
  definition: Tool;
  invoke: (rawArgs: unknown, ctx: ToolCallContext) => Promise<unknown>;
}

const PROJECT_PROP = { type: 'string', minLength: 1, description: 'Registered project ID from project_list (required; no default project).' } as const;
const TASK_ID_PROP = { type: 'string', minLength: 1, description: 'Task run ID.' } as const;

async function invokeTaskStart(rawArgs: unknown, ctx: ToolCallContext) {
  const args = taskStartInputSchema.parse(rawArgs ?? {});
  assertAllowedProject(args.project, ctx);
  const cockpit = await resolveProjectCockpit(ctx.origin, args.project, { fetch: ctx.fetch, signal: ctx.signal });
  const started = await startTask(cockpit, {
    task: args.task,
    requestId: args.requestId,
    workflow: args.workflow,
    skill: args.skill,
    runner: args.runner,
    model: args.model,
    effort: args.effort,
    autonomous: args.autonomous,
    worktree: args.worktree,
    allowWorkers: args.allowWorkers,
    allowMessaging: args.allowMessaging,
    archiveWhenDone: args.archiveWhenDone,
    autoMergePr: args.autoMergePr,
    signal: ctx.signal,
  });
  return {
    id: started.id,
    project: cockpit.projectId,
    status: started.status,
    created: started.created,
    requestId: started.requestId,
    ...(started.branch !== undefined ? { branch: started.branch } : {}),
    url: started.url,
    ...(started.warning !== undefined ? { warning: started.warning } : {}),
  };
}

function idActionTool(
  name: string,
  description: string,
  run: (cockpit: Awaited<ReturnType<typeof resolveProjectCockpit>>, id: string, signal: AbortSignal) => Promise<Record<string, unknown>>,
): ToolEntry {
  return {
    definition: {
      name,
      description,
      inputSchema: {
        type: 'object',
        required: ['project', 'id'],
        additionalProperties: false,
        properties: { project: PROJECT_PROP, id: TASK_ID_PROP },
      },
    },
    invoke: async (rawArgs, ctx) => {
      const args = taskIdInputSchema.parse(rawArgs ?? {});
      assertAllowedProject(args.project, ctx);
      const cockpit = await resolveProjectCockpit(ctx.origin, args.project, { fetch: ctx.fetch, signal: ctx.signal });
      const result = await run(cockpit, args.id, ctx.signal);
      return { project: cockpit.projectId, ...result };
    },
  };
}

const TOOLS: readonly ToolEntry[] = [
  {
    definition: {
      name: 'project_list',
      description: 'List registered projects on the Squawk cockpit. Call this first to get valid project IDs for task_* tools.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    invoke: async (rawArgs, ctx) => {
      projectListInputSchema.parse(rawArgs ?? {});
      const listed = await listProjects(ctx.origin, { fetch: ctx.fetch, signal: ctx.signal });
      if (ctx.allowedProject === undefined) return listed;
      return { projects: listed.projects.filter((entry) => entry.id === ctx.allowedProject) };
    },
  },
  {
    definition: {
      name: 'task_start',
      description: 'Start a new coding task in a registered project. Retry-safe when passing a stable requestId.',
      inputSchema: {
        type: 'object',
        required: ['project', 'task'],
        additionalProperties: false,
        properties: {
          project: PROJECT_PROP,
          task: { type: 'string', minLength: 1, maxLength: TASK_TEXT_MAX_CHARS, description: 'Task prompt text (1–100,000 characters).' },
          requestId: { type: 'string', minLength: 1, description: 'Optional idempotency key (UUID) for retry-safe starts.' },
          workflow: { type: 'string', minLength: 1, description: 'Workflow name (default quick-task; mutually exclusive with skill).' },
          skill: { type: 'string', minLength: 1, description: 'Discovered runner skill name (mutually exclusive with workflow).' },
          runner: { type: 'string', minLength: 1, description: 'Runner ID override.' },
          model: { type: 'string', minLength: 1, description: 'Model override.' },
          effort: { type: 'string', minLength: 1, description: 'Reasoning effort override.' },
          autonomous: { type: 'boolean', description: 'Run without parking for interactive input.' },
          worktree: { type: 'boolean', description: 'Run in an isolated git worktree (default true).' },
          allowWorkers: { type: 'boolean', description: 'Allow the task to spawn Squawk workers.' },
          allowMessaging: { type: 'boolean', description: 'Allow peer-task messaging.' },
          archiveWhenDone: { type: 'boolean', description: 'Archive automatically after Done.' },
          autoMergePr: { type: 'boolean', description: 'Auto-merge the task PR after Done when CI and repo rules pass.' },
        },
      },
    },
    invoke: invokeTaskStart,
  },
  {
    definition: {
      name: 'task_send',
      description: 'Send human input to steer a live task, answer a pending question, or reopen a settled session with resume: true.',
      inputSchema: {
        type: 'object',
        required: ['project', 'id', 'text'],
        additionalProperties: false,
        properties: {
          project: PROJECT_PROP,
          id: TASK_ID_PROP,
          text: { type: 'string', minLength: 1, maxLength: TASK_TEXT_MAX_CHARS, description: 'Message or answer text.' },
          resume: { type: 'boolean', description: 'Reopen a closed/settled session with this text (default false).' },
        },
      },
    },
    invoke: async (rawArgs, ctx) => {
      const args = taskSendInputSchema.parse(rawArgs ?? {});
      assertAllowedProject(args.project, ctx);
      const cockpit = await resolveProjectCockpit(ctx.origin, args.project, { fetch: ctx.fetch, signal: ctx.signal });
      const result = await sendTaskMessage(cockpit, {
        id: args.id,
        text: args.text,
        resume: args.resume ?? false,
        signal: ctx.signal,
      }, { closedHintStyle: 'mcp' });
      return {
        id: result.id,
        project: cockpit.projectId,
        delivery: result.delivery,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.hint !== undefined ? { hint: result.hint } : {}),
      };
    },
  },
  {
    definition: {
      name: 'task_status',
      description: 'Read a task status projection, including attention/attentionLabel, pending question/questionContext, and optional bounded handoff text.',
      inputSchema: {
        type: 'object',
        required: ['project', 'id'],
        additionalProperties: false,
        properties: {
          project: PROJECT_PROP,
          id: TASK_ID_PROP,
          full: { type: 'boolean', description: 'Return the full contract ApiRun record instead of the slim projection.' },
          includeHandoff: { type: 'boolean', description: 'Include bounded handoff markdown text.' },
          maxChars: { type: 'integer', minimum: 1, maximum: MAX_BOUNDED_CHARS, description: `Max characters for handoff text when includeHandoff is true (default ${DEFAULT_HANDOFF_MAX_CHARS}).` },
        },
      },
    },
    invoke: async (rawArgs, ctx) => {
      const args = taskStatusInputSchema.parse(rawArgs ?? {});
      assertAllowedProject(args.project, ctx);
      const cockpit = await resolveProjectCockpit(ctx.origin, args.project, { fetch: ctx.fetch, signal: ctx.signal });
      const status = await getTaskStatus(cockpit, {
        id: args.id,
        full: args.full,
        includeHandoff: args.includeHandoff,
        maxChars: args.maxChars ?? DEFAULT_HANDOFF_MAX_CHARS,
        signal: ctx.signal,
      });
      return { project: cockpit.projectId, ...status };
    },
  },
  {
    definition: {
      name: 'task_log',
      description: 'Read a bounded snapshot of recent task transcript events after an optional sequence number.',
      inputSchema: {
        type: 'object',
        required: ['project', 'id'],
        additionalProperties: false,
        properties: {
          project: PROJECT_PROP,
          id: TASK_ID_PROP,
          since: { type: 'integer', minimum: 0, description: 'Only return events with seq greater than this value (default 0).' },
          maxChars: { type: 'integer', minimum: 1, maximum: MAX_LOG_CHARS, description: 'Keep newest events within this character budget (default 8000).' },
        },
      },
    },
    invoke: async (rawArgs, ctx) => {
      const args = taskLogInputSchema.parse(rawArgs ?? {});
      assertAllowedProject(args.project, ctx);
      const cockpit = await resolveProjectCockpit(ctx.origin, args.project, { fetch: ctx.fetch, signal: ctx.signal });
      const snapshot = await getTaskLog(cockpit, {
        id: args.id,
        since: args.since ?? 0,
        maxChars: args.maxChars ?? 8_000,
        signal: ctx.signal,
      });
      return {
        id: snapshot.id,
        project: cockpit.projectId,
        events: snapshot.events,
        lastSeq: snapshot.lastSeq,
        truncated: snapshot.truncated,
      };
    },
  },
  {
    definition: {
      name: 'task_diff',
      description: 'Read a task change stat summary (stat: true) or bounded unified diff patch.',
      inputSchema: {
        type: 'object',
        required: ['project', 'id'],
        additionalProperties: false,
        properties: {
          project: PROJECT_PROP,
          id: TASK_ID_PROP,
          stat: { type: 'boolean', description: 'Return per-file change counts instead of the unified diff patch.' },
          maxChars: { type: 'integer', minimum: 1, maximum: MAX_BOUNDED_CHARS, description: `Max characters for non-stat diff output (default ${DEFAULT_DIFF_MAX_CHARS}).` },
        },
      },
    },
    invoke: async (rawArgs, ctx) => {
      const args = taskDiffInputSchema.parse(rawArgs ?? {});
      assertAllowedProject(args.project, ctx);
      const cockpit = await resolveProjectCockpit(ctx.origin, args.project, { fetch: ctx.fetch, signal: ctx.signal });
      const result = await getTaskDiff(cockpit, {
        id: args.id,
        stat: args.stat,
        maxChars: args.stat ? undefined : (args.maxChars ?? DEFAULT_DIFF_MAX_CHARS),
        signal: ctx.signal,
      });
      return { project: cockpit.projectId, ...result };
    },
  },
  {
    definition: {
      name: 'task_wait',
      description: 'Wait until one or more tasks need attention (default) or reach a terminal status. Supports cancellation and 15 s progress heartbeats.',
      inputSchema: {
        type: 'object',
        required: ['project', 'ids'],
        additionalProperties: false,
        properties: {
          project: PROJECT_PROP,
          ids: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1, maxItems: 32, description: '1–32 task IDs to wait on.' },
          mode: { type: 'string', enum: ['any', 'all'], description: 'Return when any task matches or all tasks match (default any).' },
          until: { type: 'string', enum: ['attention', 'settled'], description: 'Stop when a task needs input or ends (attention, default), or terminal status only (settled).' },
          timeoutSeconds: { type: 'integer', minimum: 1, maximum: MAX_WAIT_TIMEOUT_SECONDS, description: `Max seconds to wait (1–${MAX_WAIT_TIMEOUT_SECONDS}, default ${DEFAULT_WAIT_TIMEOUT_SECONDS}).` },
        },
      },
    },
    invoke: async (rawArgs, ctx) => {
      const args = taskWaitInputSchema.parse(rawArgs ?? {});
      assertAllowedProject(args.project, ctx);
      const cockpit = await resolveProjectCockpit(ctx.origin, args.project, { fetch: ctx.fetch, signal: ctx.signal });
      const mode = args.mode ?? 'any';
      const until = args.until ?? 'attention';
      const timeoutSeconds = args.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
      const waited = await waitForTasks(cockpit, {
        ids: args.ids,
        mode,
        until,
        timeoutMs: timeoutSeconds * 1_000,
        pollMs: ctx.pollMs,
        heartbeatMs: ctx.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
        signal: ctx.signal,
        onHeartbeat: ctx.sendProgress
          ? (elapsedMs: number, entries: readonly WaitEntry[]) => ctx.sendProgress!(
            Math.floor(elapsedMs / 1_000),
            timeoutSeconds,
            `waiting on ${entries.length} task(s): ${entries.map((entry) => `${entry.id}=${entry.status}`).join(', ')}`,
          )
          : undefined,
      });
      return {
        project: cockpit.projectId,
        until: waited.until,
        mode,
        timedOut: waited.timedOut,
        runs: waited.runs,
      };
    },
  },
  idActionTool('task_stop', 'Cancel a running or queued task.', (cockpit, id, signal) => stopTask(cockpit, id, signal)),
  idActionTool('task_finish', 'Close a waiting task session as done.', (cockpit, id, signal) => finishTask(cockpit, id, signal)),
  idActionTool('task_archive', 'Archive a task to hide it from default listings.', (cockpit, id, signal) => archiveTask(cockpit, id, true, signal)),
  {
    definition: {
      name: 'task_list',
      description: 'List tasks newest-first for one project or across all projects (project: "all"). Owned workers are excluded.',
      inputSchema: {
        type: 'object',
        required: ['project'],
        additionalProperties: false,
        properties: {
          project: { type: 'string', minLength: 1, description: 'Registered project ID from project_list, or "all" for all projects.' },
          status: { type: 'string', description: `Optional status or comma-separated statuses: ${STATUS_LIST}.` },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max tasks to return (1–200, default 20).' },
          all: { type: 'boolean', description: 'Include archived tasks.' },
          full: { type: 'boolean', description: 'Return full contract records instead of slim list rows.' },
        },
      },
    },
    invoke: async (rawArgs, ctx) => {
      const args = taskListInputSchema.parse(rawArgs ?? {});
      assertAllowedProject(args.project, ctx);
      const statuses = parseStatusFilter(args.status);
      const limit = args.limit ?? 20;
      if (args.project === 'all' && ctx.allowedProject === undefined) {
        return listAllProjectsTasks(ctx.origin, {
          statuses,
          limit,
          all: args.all,
          full: args.full,
          fetch: ctx.fetch,
          signal: ctx.signal,
        });
      }
      const cockpit = await resolveProjectCockpit(ctx.origin, args.project, { fetch: ctx.fetch, signal: ctx.signal });
      const listed = await listTasks(cockpit, {
        statuses,
        limit,
        all: args.all,
        full: args.full,
        signal: ctx.signal,
      });
      return { project: cockpit.projectId, total: listed.total, runs: listed.runs };
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((entry) => [entry.definition.name, entry]));

function formatZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'invalid arguments';
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${path}${first.message}`;
}

export function formatMcpToolError(error: unknown): { isError: true; content: [{ type: 'text'; text: string }] } {
  if (error instanceof TaskCliError) {
    const code = typeof error.body.code === 'string' ? error.body.code : 'error';
    const message = typeof error.body.error === 'string' ? error.body.error : error.message;
    const hint = typeof error.body.hint === 'string' ? error.body.hint : undefined;
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code, error: message, ...(hint ? { hint } : {}) }) }],
    };
  }
  if (error instanceof z.ZodError) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify({ code: 'invalid_input', error: formatZodError(error) }) }],
    };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ code: 'internal', error: error instanceof Error ? error.message : String(error) }) }],
  };
}

export function createOrchestratorMcpServer(options: OrchestratorMcpOptions): Server {
  const server = new Server(
    { name: MCP_SERVER_NAME, version: options.version ?? '0.0.0' },
    { capabilities: { tools: {} }, instructions: MCP_SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((entry) => entry.definition),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = TOOLS_BY_NAME.get(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'unknown_tool', error: `unknown tool '${request.params.name}'` }) }],
      };
    }
    const progressToken = extra._meta?.progressToken;
    const sendProgress = progressToken !== undefined
      ? async (progress: number, total: number, message: string) => {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress, total, message },
        });
      }
      : undefined;
    const signal = options.requestSignal ? AbortSignal.any([extra.signal, options.requestSignal]) : extra.signal;
    try {
      const data = await tool.invoke(request.params.arguments, {
        origin: options.origin,
        fetch: options.fetch,
        pollMs: options.pollMs,
        heartbeatMs: options.heartbeatMs,
        allowedProject: options.allowedProject,
        signal,
        sendProgress,
      });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    } catch (error) {
      return formatMcpToolError(error);
    }
  });
  return server;
}
