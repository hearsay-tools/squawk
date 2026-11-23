import type { AgentToolResult } from './tool-registry.ts';
import { agentToolCatalogSchema, agentToolResultSchema } from '@open-mercato/cezar-contract/agent-tools';
import { automationToolAnswerSchema, type AutomationToolAnswer } from '@open-mercato/cezar-contract/automation-tool';
import { AUTOMATION_TOOL_CLIENT_TIMEOUT_MS } from '../core/github-request-limits.ts';
import { productEnv } from '../core/product-env.ts';
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { previewStopResult } from '../preview/registration.ts';
import { previewRefusal } from './errors.ts';
import { squawkAskAnswerSchema, squawkCancelWaitAnswerSchema, squawkDoneAnswerSchema, squawkWaitAnswerSchema, type SquawkAskAnswer, type SquawkCancelWaitAnswer, type SquawkDoneAnswer, type SquawkWaitAnswer } from '@open-mercato/cezar-contract/wait-tools';
import { SCHEDULED_TASK_LIMITS, scheduleTaskAnswerSchema, scheduledTasksAnswerSchema, type ScheduleTaskAnswer, type ScheduledTasksAnswer } from '@open-mercato/cezar-contract/scheduled-tasks';
import { previewServeResultSchema, previewStopResultSchema, type PreviewStopResult, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';

const UNAVAILABLE = 'CI tool unavailable: the owning session is closed or the private IPC connection failed.';
const SCHEDULE_UNAVAILABLE = `Squawk could not reach its scheduler: the owning session is closed or the private IPC connection failed.`;
/**
 * #781: posts the arguments unparsed, so the server names the failing field in its hint. Every
 * transport failure, refusal or unreadable answer becomes the typed `unavailable` result; this
 * never throws.
 */
export function callPreviewServe(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<PreviewServeResult> {
  return callTool(input, env, 'cezar_preview_serve', previewServeResultSchema, previewRefusal('unavailable'));
}

export function callPreviewStop(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<PreviewStopResult> {
  return callTool(input, env, 'cezar_preview_stop', previewStopResultSchema, previewStopResult('unavailable'));
}

/** hearsay-tools/cezarion#1233: unparsed like preview, so the server names the failing field. */
export async function callSquawkWait(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<SquawkWaitAnswer> {
  if (!productEnv('TOOL_SOCKET', env) || !productEnv('TOOL_TOKEN', env)) return { ok: false, effect: 'refused', code: 'unavailable', message: 'No local tool capability is configured. Nothing was created.' };
  const identified = input && typeof input === 'object' && !Array.isArray(input)
    ? { ...input, operation_id: 'operation_id' in input ? input.operation_id : randomUUID() } : input;
  const operationId = identified && typeof identified === 'object' && 'operation_id' in identified && typeof identified.operation_id === 'string' ? identified.operation_id : undefined;
  const unknown: SquawkWaitAnswer = { ok: false, effect: 'unknown', code: 'outcome_unknown', ...(operationId ? { operation_id: operationId } : {}),
    message: 'Registration outcome is unknown. Retry the same operation_id and arguments to recover its receipt. Do not assume nothing was created, cancel a retained wait, or add a fallback timer.' };
  const deadline = Date.now() + 15_000;
  const first = await callTool(identified, env, 'cezar_wait', squawkWaitAnswerSchema, unknown, 32_768, 7_500, true);
  if (first.ok || first.code !== 'outcome_unknown' || !operationId || Date.now() >= deadline) return first;
  return callTool(identified, env, 'cezar_wait', squawkWaitAnswerSchema, unknown, 32_768, Math.max(1, deadline - Date.now()), true);
}

export function callSquawkCancelWait(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<SquawkCancelWaitAnswer> {
  return callTool(input, env, 'cezar_cancel_wait', squawkCancelWaitAnswerSchema, { cancelled: false, code: 'unavailable', message: UNAVAILABLE });
}

/** hearsay-tools/cezarion#1234: unparsed too, so the server names an unknown field. */
export function callSquawkDone(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<SquawkDoneAnswer> {
  return callTool(input, env, 'cezar_done', squawkDoneAnswerSchema, { ok: false, code: 'unavailable', message: UNAVAILABLE });
}

/** hearsay-tools/cezarion#1234: unparsed too, so the server names the failing question. */
export function callSquawkAsk(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<SquawkAskAnswer> {
  return callTool(input, env, 'cezar_ask', squawkAskAnswerSchema, { ok: false, code: 'unavailable', message: UNAVAILABLE });
}

/**
 * hearsay-tools/cezarion#1465: unparsed too. A list of 50 schedules can pass the 32 KiB the
 * other answers fit in, so these two read up to the schedule answer cap.
 */
export function callScheduleTask(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<ScheduleTaskAnswer> {
  return callTool(input, env, 'cezar_schedule_task', scheduleTaskAnswerSchema, { ok: false, code: 'unavailable', message: SCHEDULE_UNAVAILABLE }, SCHEDULED_TASK_LIMITS.wireBytes);
}

export function callScheduledTasks(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<ScheduledTasksAnswer> {
  return callTool(input, env, 'cezar_scheduled_tasks', scheduledTasksAnswerSchema, { ok: false, code: 'unavailable', message: SCHEDULE_UNAVAILABLE }, SCHEDULED_TASK_LIMITS.wireBytes);
}

export function callAutomation(input: unknown, env: NodeJS.ProcessEnv = process.env): Promise<AutomationToolAnswer> {
  return callTool(input, env, 'cezar_automation', automationToolAnswerSchema, { ok: false, code: 'unavailable', message: SCHEDULE_UNAVAILABLE }, SCHEDULED_TASK_LIMITS.wireBytes, AUTOMATION_TOOL_CLIENT_TIMEOUT_MS);
}

export function callTool<T>(input: unknown, env: NodeJS.ProcessEnv, route: string, schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } }, unavailable: T, maxAnswerBytes = 32_768, timeoutMs = 15_000, typedErrors = false, method = 'POST', formatted = false): Promise<T> {
  const socketPath = productEnv('TOOL_SOCKET', env); const token = productEnv('TOOL_TOKEN', env);
  if (!socketPath || !token) return Promise.resolve(unavailable);
  return new Promise(resolve => {
    let done = false;
    const finish = (answer: T) => { if (done) return; done = true; clearTimeout(timer); resolve(answer); };
    // One connection per call (hearsay-tools/cezarion#1465): Node 24.15 raised an uncaught EPIPE
    // from a pooled keep-alive socket after a large schedule call when the controller closed.
    const req = request({ socketPath, agent: false, path: route ? `/api/v1/tools/${encodeURIComponent(route)}` : '/api/v1/tools', method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(formatted ? { accept: 'application/x-squawk-tool-result+json' } : {}) } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxAnswerBytes) req.destroy(); else chunks.push(chunk); });
      response.on('error', () => finish(unavailable));
      response.on('end', () => {
        try {
          const result = schema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          finish((response.statusCode === 200 || typedErrors) && result.success ? result.data : unavailable);
        } catch { finish(unavailable); }
      });
    });
    // bound: total request duration, including a peer that keeps a socket active without an answer.
    const timer = setTimeout(() => { req.destroy(); finish(unavailable); }, timeoutMs);
    req.on('error', () => finish(unavailable));
    req.end(method === 'GET' ? undefined : JSON.stringify(input ?? null));
  });
}

/**
 * Controller pipe death (including SIGKILL) bounds the adapter's lifetime. The GET keeps its
 * historical `ci-wait` path; the POST of the removed `cezar_wait_for_ci` (hearsay-tools/cezarion#1236) is gone.
 */
export function monitorCiOwner(onClose: () => void, env: NodeJS.ProcessEnv = process.env): () => void {
  let stopped = false;
  const close = () => { if (!stopped) { stopped = true; onClose(); } };
  if (!productEnv('TOOL_SOCKET', env) || !productEnv('TOOL_TOKEN', env)) { queueMicrotask(close); return () => { stopped = true; }; }
  const req = request({ socketPath: productEnv('TOOL_SOCKET', env), path: '/api/v1/tools/ci-wait', headers: { authorization: `Bearer ${productEnv('TOOL_TOKEN', env)}` } }, response => {
    if (response.statusCode !== 200) { response.resume(); close(); return; }
    response.resume(); response.on('end', close); response.on('error', close); response.on('close', close);
  });
  req.on('error', close); req.end();
  return () => { stopped = true; req.destroy(); };
}

/** External tool hosts discover the owning session's catalog, never their own feature flags. */
export async function fetchToolCatalog(env: NodeJS.ProcessEnv = process.env) {
  const catalog = await callTool(null, env, '', agentToolCatalogSchema, null, 4_194_304, 15_000, false, 'GET');
  if (!catalog) throw new Error('Squawk tool catalog unavailable: the owning session is closed or the private IPC connection failed.');
  return catalog;
}
export async function invokeRemoteTool(name: string, input: unknown, env: NodeJS.ProcessEnv = process.env, policy?: { timeoutMs: number; unavailable: AgentToolResult }) {
  // Core wait calls recover a committed registration receipt after a lost IPC response.
  if (name === 'cezar_wait') {
    const { formatWaitTool } = await import('./tools.ts');
    return formatWaitTool(await callSquawkWait(input, env));
  }
  const unavailable = policy?.unavailable ?? { content: [{ type: 'text' as const, text: UNAVAILABLE }], isError: true, details: null };
  return callTool(input, env, name, agentToolResultSchema, unavailable, 4_194_304, policy?.timeoutMs ?? 15_000, false, 'POST', true);
}
export async function remoteSquawkTools(env: NodeJS.ProcessEnv = process.env) {
  const catalog = await fetchToolCatalog(env);
  return { instructions: catalog.instructions, tools: catalog.tools.map(tool => ({ definition: tool, label: tool.label, trigger: tool.trigger,
    invoke: (input: unknown) => invokeRemoteTool(tool.name, input, env, tool) })) };
}

/** Pi and OMP use the same async extension registration contract. */
export async function registerRemoteSquawkTools(host: { registerTool(tool: {
  name: string; label: string; description: string;
  parameters: import('./tool-registry.ts').JsonObject;
  execute(callId: string, params: unknown): Promise<AgentToolResult>;
}): void }) {
  const { tools } = await remoteSquawkTools();
  for (const tool of tools) host.registerTool({
    name: tool.definition.name, label: tool.label, description: tool.definition.description, parameters: tool.definition.inputSchema,
    execute: async (_callId, params) => tool.invoke(params),
  });
}
