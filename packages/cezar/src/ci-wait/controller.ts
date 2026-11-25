import { squawkToolEnvNames } from './tool-names.ts';
import { agentTool, registeredAgentTools, type AgentToolDefinition, formatAgentToolAnswer, agentToolTransport, enabledAgentTools, agentToolMetadata, agentToolInstructions } from './tool-registry.ts';
import { type AutomationToolRequest, type AutomationToolAnswer } from '@open-mercato/cezar-contract/automation-tool';
import { productEnvEntries } from '../core/product-env.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createMiddleware } from 'hono/factory';

import { ciErrorMessage, ToolsUnavailableError } from './errors.ts';
export { ToolsUnavailableError } from './errors.ts';
import { type ScheduleTaskAnswer, type ScheduleTaskRequest, type ScheduledTasksAnswer, type ScheduledTasksRequest } from '@open-mercato/cezar-contract/scheduled-tasks';
import { type Wait, type WaitVia } from '@open-mercato/cezar-contract/waits';
import { type SquawkAskAnswer, type SquawkAskRequest, type SquawkCancelWaitAnswer, type SquawkCancelWaitRequest, type SquawkDoneAnswer, type SquawkDoneRequest, type SquawkWaitAnswer, type SquawkWaitRequestInput } from '@open-mercato/cezar-contract/wait-tools';

import { type PreviewStopRequest, type PreviewStopResult, type PreviewServeRequest, type PreviewServeResult } from '@open-mercato/cezar-contract/preview';
import { jsonZodValidator } from '../server/validators.ts';
import type { AgentRunSpec } from '../core/agent-runner.ts';

/**
 * hearsay-tools/cezarion#1233: what `registerWait` settles to. The agent sees `answer`; an accepted
 * registration also carries the entry it opened.
 */
export type WaitRegistration =
  | { answer: Extract<SquawkWaitAnswer, { ok: true }>; wait: Wait }
  | { answer: Extract<SquawkWaitAnswer, { ok: false }> };
/** `signal` aborts when the session's capability is revoked (cancel, stop, session end). */
type PreviewRegistration = (request: PreviewServeRequest, signal: AbortSignal) => Promise<PreviewServeResult>;
type PreviewStop = (request: PreviewStopRequest, signal: AbortSignal) => Promise<PreviewStopResult>;
/** The session's trusted callbacks: run identity comes from here, never from the model's arguments. */
export type SquawkToolHandlers = {
  tools?: Record<string, (input: unknown, signal: AbortSignal) => Promise<unknown>>;
  /** `via` names the tool that opened the wait. */
  registerWait: (request: SquawkWaitRequestInput, via: WaitVia, signal: AbortSignal) => Promise<WaitRegistration>;
  /** `cezar_ask` (hearsay-tools/cezarion#1234): opens the run's human wait with its card. */
  ask: (request: SquawkAskRequest, signal: AbortSignal) => Promise<SquawkAskAnswer>;
  cancelWait: (request: SquawkCancelWaitRequest, signal: AbortSignal) => Promise<SquawkCancelWaitAnswer>;
  /** `cezar_done` (hearsay-tools/cezarion#1234): accepted means the run, or a workflow step that is not the last, finishes at this turn's end (hearsay-tools/cezarion#1620). */
  finishTurn: (request: SquawkDoneRequest, signal: AbortSignal) => Promise<SquawkDoneAnswer>;
  /** #781: absent where no cockpit owns the run, which the route answers as `headless`. */
  registerPreview?: PreviewRegistration | undefined;
  stopPreview?: PreviewStop | undefined;
  /** hearsay-tools/cezarion#1465: absent where no cockpit serves the project, answered as `unavailable`. */
  scheduleTask?: (request: ScheduleTaskRequest, signal: AbortSignal) => Promise<ScheduleTaskAnswer>;
  automation?: (request: AutomationToolRequest, signal: AbortSignal) => Promise<AutomationToolAnswer>;
  scheduledTasks?: (request: ScheduledTasksRequest, signal: AbortSignal) => Promise<ScheduledTasksAnswer>;
};
type Capability = SquawkToolHandlers & { lifetime: AbortController; env: NodeJS.ProcessEnv };
export type CiToolSession = { descriptor: NonNullable<AgentRunSpec['squawkTools']>; env: Record<string, string>; revoke(): void };

function temporaryRootFor(): string {
  return Buffer.byteLength(tmpdir()) > 64 ? '/tmp' : tmpdir();
}

/** Where the private socket lives, or undefined for a Windows named pipe. */
function socketRoot(): string | undefined {
  return process.platform === 'win32' ? undefined : temporaryRootFor();
}

/** The OS error's own words (code, syscall and path), bounded; never an environment value. */
function startFailureDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, 300) || 'unknown error';
}

/** The file URL of the running copy's tool client (`client.ts` under source, `client.js` when built). */
export function runningToolClientUrl(moduleUrl: string = import.meta.url): string {
  return new URL(extname(fileURLToPath(moduleUrl)) === '.ts' ? './client.ts' : './client.js', moduleUrl).href;
}

/** Separate from the cockpit and delegation APIs. No TCP listener or durable credentials. */
export class CiToolController {
  private readonly capabilities = new Map<string, Capability>();
  private readonly sockets = new Set<Socket>();
  private closed = false;
  private constructor(private readonly server: Server, private readonly address: string, private readonly directory?: string) {}

  static async start(): Promise<CiToolController> {
    registeredAgentTools();
    let directory: string | undefined;
    let server: Server | undefined;
    try {
      // sockaddr_un is only 104–108 bytes on supported Unix platforms. Agent
      // worktree TMPDIRs can be much longer; the endpoint must not inherit that.
      const temporaryRoot = temporaryRootFor();
      directory = process.platform === 'win32' ? undefined : await mkdtemp(join(temporaryRoot, 'cez-ci-'));
      if (directory) await chmod(directory, 0o700);
      const address = directory ? join(directory, 'ipc') : `\\\\.\\pipe\\cezar-ci-${randomUUID()}`;
      server = createServer();
      const controller = new CiToolController(server, address, directory);
      const app = ciToolRoutes(controller.capabilities);
      server.on('request', getRequestListener(app.fetch));
      server.on('connection', socket => { controller.sockets.add(socket); socket.on('close', () => controller.sockets.delete(socket)); });
      server.maxConnections = 64;
      server.headersTimeout = 5000;
      server.requestTimeout = 15000;
      await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(address, () => { server!.off('error', reject); resolve(); }); });
      if (directory) await chmod(address, 0o600);
      server.unref();
      return controller;
    } catch (error) {
      server?.close();
      server?.closeAllConnections();
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw new ToolsUnavailableError(startFailureDetail(error), socketRoot());
    }
  }

  provision(handlers: SquawkToolHandlers): CiToolSession {
    if (this.closed) throw new ToolsUnavailableError('the tool controller was closed', socketRoot());
    const token = randomBytes(32).toString('hex');
    const capability: Capability = { ...handlers, lifetime: new AbortController(), env: { ...process.env } };
    this.capabilities.set(token, capability);
    const entry = fileURLToPath(new URL('./mcp.js', import.meta.url));
    // Source execution uses tsx already installed by the developer; installed artifacts use plain Node.
    const source = import.meta.url.endsWith('.ts');
    return {
      descriptor: { name: `cezar_ci_${randomUUID().replaceAll('-', '')}`, command: process.execPath, args: source ? ['--import', fileURLToPath(import.meta.resolve('tsx')), entry.replace(/\.js$/, '.ts')] : [entry] },
      // #781: the session carries the preview opt-in, so its runner admits and forwards exactly
      // the tools this session's adapter lists.
      env: { ...Object.fromEntries(Object.entries(capability.env).filter((entry): entry is [string, string] => entry[1] !== undefined && squawkToolEnvNames(capability.env).includes(entry[0]))), ...productEnvEntries('TOOL_TOKEN', token), ...productEnvEntries('TOOL_SOCKET', this.address), ...productEnvEntries('TOOL_CLIENT', runningToolClientUrl()), ...Object.assign({}, ...registeredAgentTools().map(tool => tool.sessionEnv?.(capability.env) ?? {})) },
      revoke: () => { this.capabilities.delete(token); capability.lifetime.abort(); },
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const capability of this.capabilities.values()) capability.lifetime.abort();
    this.capabilities.clear();
    const closed = new Promise<void>(resolve => this.server.close(() => resolve()));
    for (const socket of this.sockets) socket.destroy();
    await closed;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
  }
}

/** The private IPC catalog and registered dispatch share the capability boundary. */
export function ciToolRoutes(capabilities: Map<string, Capability>) {
  const requireCapability = createMiddleware<{ Variables: { capability: Capability; tool: AgentToolDefinition } }>(async (c, next) => {
    const authorization = c.req.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    const capability = token ? capabilities.get(token) : undefined;
    if (!capability || capability.lifetime.signal.aborted) return c.json({ code: 'unauthorized', message: ciErrorMessage('unauthorized') }, 401);
    c.set('capability', capability);
    await next();
  });
  const app = new Hono<{ Variables: { capability: Capability; tool: AgentToolDefinition } }>()
    .use('/api/v1/tools', requireCapability)
    .use('/api/v1/tools/*', requireCapability)
    .use('/api/v1/tools/*', async (c, next) => {
      await next();
      if (c.req.header('accept') !== 'application/x-squawk-tool-result+json' || c.res.status !== 200) return;
      const tool = agentTool(c.req.path.split('/').at(-1)!);
      if (!tool) return;
      const answer: unknown = await c.res.json();
      c.res = c.json(formatAgentToolAnswer(tool, answer));
    })
    .get('/api/v1/tools', c => {
      const tools = enabledAgentTools(c.get('capability').env).map(tool => ({ ...agentToolMetadata(tool), ...agentToolTransport(tool) }));
      return c.json({ tools, instructions: agentToolInstructions(tools) });
    })
    .get('/api/v1/tools/ci-wait', c => {
      const signal = c.get('capability').lifetime.signal;
      let release = () => {};
      return new Response(new ReadableStream<Uint8Array>({ start(stream) {
        stream.enqueue(new TextEncoder().encode('connected\n'));
        const close = () => { try { stream.close(); } catch {} };
        signal.addEventListener('abort', close, { once: true });
        release = () => signal.removeEventListener('abort', close);
      }, cancel() { release(); } }), { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
    });
  const validate: MiddlewareHandler<{ Variables: { capability: Capability; tool: AgentToolDefinition } }, string, { in: { json: unknown }; out: { json: unknown } }> = (c, next) => {
    const tool = c.get('tool');
    return jsonZodValidator<typeof tool.schema, { Variables: { capability: Capability; tool: AgentToolDefinition } }>(tool.schema, { invalid: (c, error, input) => c.json(tool.invalid(error, input)), ...(tool.runnerFields ? { runners: tool.runnerFields } : {}) })(c, next);
  };
  return app.post('/api/v1/tools/:name',
    async (c, next) => {
      const tool = agentTool(c.req.param('name'));
      if (!tool) return c.json({ code: 'unknown_tool', message: 'Unknown tool' }, 404);
      c.set('tool', tool);
      await next();
    },
    (c, next) => {
      const tool = c.get('tool');
      return bodyLimit({ maxSize: tool.maxBodyBytes ?? 16_384, onError: c => c.json(tool.oversized()) })(c, next);
    },
    async (c, next) => {
      const tool = c.get('tool');
      if (tool.enabled && !tool.enabled(c.get('capability').env)) return c.json(tool.disabled?.() ?? { code: 'disabled' });
      await next();
    }, validate,
    async c => {
      const capability = c.get('capability');
      const tool = c.get('tool');
      const input = c.req.valid('json');
      try {
        const handler = capability.tools?.[tool.name];
        const result = handler ? await handler(input, capability.lifetime.signal) : await tool.handle(capability, input, capability.lifetime.signal);
        if (!tool.committedReceipt) capability.lifetime.signal.throwIfAborted();
        return c.json(result);
      } catch (error) {
        return capability.lifetime.signal.aborted
          ? c.json({ code: 'capability_revoked', message: ciErrorMessage('capability_revoked') }, 401)
          : c.json(tool.unavailable(error, input));
      }
    });
}

export type CiToolApp = ReturnType<typeof ciToolRoutes>;
