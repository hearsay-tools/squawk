import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { z } from 'zod';
import type { StopReason, TokenUsage } from '../../core/ui-events.ts';
import { AcpEvents, type AcpEventSink } from './events.ts';
import { AcpRpcError, AcpTransport } from './transport.ts';
import { initializeSchema, permissionSchema, recordSchema, type AcpAsk, type AcpHooks, type AcpInitializeResult, type AcpPermissionRequest } from './protocol.ts';

const updateSchema = z.object({ sessionId: z.string(), update: recordSchema });
const promptResultSchema = z.object({ stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) }).passthrough();
interface PendingPermission { request: AcpPermissionRequest; ask?: AcpAsk; resolve(value: unknown): void }
export interface AcpSessionOptions extends AcpEventSink {
  backend: string;
  clientInfo: { name: string; version: string };
  hooks?: AcpHooks;
  onActivity?: () => void;
}
export interface AcpOpenOptions {
  cwd: string;
  mcpServers?: readonly Record<string, unknown>[];
  sessionId?: string;
  /** Loading can replay history. A runner opts in instead of silently replaying tools. */
  loadFallback?: boolean;
}

/** One logical ACP session on caller-owned stdio. The runner wraps this in AgentSession
 * and owns process exit, deadlines, input delivery and its RunnerFacts. */
export class AcpSession {
  readonly transport: AcpTransport;
  private readonly events: AcpEvents;
  private readonly hooks: AcpHooks;
  private hello: AcpInitializeResult | undefined;
  private sessionId: string | undefined;
  private opening = false;
  private earlyUpdates: Array<z.infer<typeof updateSchema>> = [];
  private permissions = new Map<string, PendingPermission>();
  private permissionSerial = 0;
  private readonly permissionPrefix = randomUUID();
  private closed = false;
  private promptOwner: symbol | undefined;
  private readonly prompts = new Set<symbol>();
  private get promptActive(): boolean { return this.promptOwner !== undefined; }
  private turnCancelled = false;

  constructor(streams: { input: Writable; output: Readable }, private readonly options: AcpSessionOptions) {
    this.hooks = options.hooks ?? {};
    this.events = new AcpEvents(options, this.hooks);
    this.transport = new AcpTransport(streams, {
      notification: (method, params) => this.notification(method, params),
      request: (method, params) => this.request(method, params),
      notice: message => this.events.notice(message),
      ...(options.onActivity ? { activity: options.onActivity } : {}),
    });
    void this.transport.completion.then(() => { this.closed = true; this.cancelPermissions(); });
  }

  async initialize(): Promise<AcpInitializeResult> {
    if (this.hello) throw new Error('ACP already initialized');
    this.hello = initializeSchema.parse(await this.transport.request('initialize', {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: !!this.hooks.readTextFile, writeTextFile: false } },
      clientInfo: this.options.clientInfo,
    }));
    const method = this.hooks.selectAuthMethod?.(this.hello);
    if (method) await this.authenticate(method);
    return this.hello;
  }

  async authenticate(methodId: string): Promise<void> {
    if (!this.hello?.authMethods.some(method => method.id === methodId)) throw new Error(`ACP authentication method unavailable: ${methodId}`);
    recordSchema.parse(await this.transport.request('authenticate', { methodId }));
  }

  async open(options: AcpOpenOptions): Promise<string> {
    if (!this.hello) throw new Error('Initialize ACP before opening a session');
    if (this.opening || this.sessionId) throw new Error('ACP session already opened');
    this.opening = true;
    try {
      const method = this.openMethod(options);
      const params = { cwd: options.cwd, mcpServers: options.mcpServers ?? [], ...(options.sessionId ? { sessionId: options.sessionId } : {}) };
      const result = recordSchema.parse(await this.transport.request(`session/${method}`, {
        ...params, ...this.hooks.sessionParams?.(method, params),
      }));
      const id = method === 'new' ? z.string().min(1).parse(result.sessionId) : options.sessionId!;
      this.sessionId = id;
      this.options.event?.({ type: 'session', sessionId: id, resumed: method !== 'new' });
      this.options.uiEvent?.({ type: 'session.started', sessionId: id, backend: this.options.backend, cwd: options.cwd });
      this.hooks.normalizeOptions?.(result.configOptions);
      for (const update of this.earlyUpdates) if (update.sessionId === id) this.events.update(update.update);
      return id;
    } finally {
      this.opening = false;
      this.earlyUpdates = [];
    }
  }

  private openMethod(options: AcpOpenOptions): 'new' | 'resume' | 'load' {
    if (!options.sessionId) return 'new';
    const caps = this.hello!.agentCapabilities;
    const sessions = recordSchema.safeParse(caps.sessionCapabilities);
    if (sessions.success && sessions.data.resume !== undefined) return 'resume';
    if (options.loadFallback && caps.loadSession === true) return 'load';
    throw new Error('ACP agent does not support session/resume; session/load requires explicit opt-in');
  }

  async prompt(content: readonly Record<string, unknown>[]): Promise<z.infer<typeof promptResultSchema>> {
    if (this.promptActive) throw new Error('ACP prompt already active');
    return this.requestPrompt(content);
  }

  /** An early concurrent response acknowledges steering. If the original response
   * arrives first, the pending prompt owns a successor turn and its permission lifetime. */
  async steer(content: readonly Record<string, unknown>[]): Promise<void> {
    if (!this.promptActive) throw new Error('ACP steering requires an active prompt');
    await this.requestPrompt(content);
  }

  private async requestPrompt(content: readonly Record<string, unknown>[]): Promise<z.infer<typeof promptResultSchema>> {
    const sessionId = this.requireSession();
    const token = Symbol('prompt');
    this.prompts.add(token);
    if (!this.promptOwner) this.beginPrompt(token);
    let result: z.infer<typeof promptResultSchema>;
    try {
      result = promptResultSchema.parse(await this.transport.request('session/prompt', { sessionId, prompt: content }));
      if (this.promptOwner === token) {
        const message = this.hooks.promptError?.();
        if (message) throw new Error(message);
      }
    } catch (error) {
      this.finishPrompt(token, this.turnCancelled ? 'cancelled' : 'error');
      throw error;
    }
    const reason: StopReason = result.stopReason === 'max_turn_requests' ? 'max_tokens' : result.stopReason;
    this.finishPrompt(token, reason, this.hooks.normalizeUsage?.(result.usage));
    return result;
  }

  private beginPrompt(token: symbol): void {
    this.promptOwner = token;
    this.turnCancelled = false;
    this.events.begin();
  }

  private finishPrompt(token: symbol, reason: StopReason, usage?: TokenUsage): void {
    this.prompts.delete(token);
    if (this.promptOwner !== token) return;
    this.cancelPermissions();
    this.events.finish(reason, usage);
    this.promptOwner = undefined;
    const next = this.prompts.values().next().value;
    if (next && !this.closed) this.beginPrompt(next);
  }

  cancel(): void {
    const sessionId = this.requireSession();
    this.turnCancelled = true;
    try { this.transport.notify('session/cancel', { sessionId }); }
    finally { this.cancelPermissions(); }
  }

  async setConfigOption(configId: string, value: string): Promise<unknown> {
    const result = recordSchema.parse(await this.transport.request('session/set_config_option', { sessionId: this.requireSession(), configId, value }));
    this.hooks.normalizeOptions?.(result.configOptions);
    return result.configOptions;
  }

  respondPermission(requestId: string, optionId: string): boolean {
    const pending = this.permissions.get(requestId);
    if (!pending || pending.ask || !pending.request.options.some(option => option.optionId === optionId)) return false;
    this.permissions.delete(requestId);
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
    this.options.uiEvent?.({ type: 'permission.resolved', requestId, optionId });
    return true;
  }

  respondAsk(requestId: string, answer: unknown): boolean {
    const pending = this.permissions.get(requestId);
    if (!pending?.ask) return false;
    let response: unknown;
    try { response = pending.ask.answer(answer); }
    catch (error) {
      // Native choices can have no free-text route. Refuse visibly and release the
      // request, rather than keep a question the caller thinks it answered.
      response = { outcome: { outcome: 'cancelled' } };
      this.events.notice(error instanceof Error ? error.message : 'Native question rejected the answer');
    }
    this.permissions.delete(requestId);
    pending.resolve(response);
    return true;
  }

  close(): void { this.closed = true; this.turnCancelled = true; this.cancelPermissions(); this.transport.close(); }

  private requireSession(): string {
    if (!this.sessionId) throw new Error('ACP session is not open');
    return this.sessionId;
  }

  private notification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const update = updateSchema.parse(params);
    if (this.opening) this.earlyUpdates.push(update);
    else if (update.sessionId === this.sessionId && this.hooks.filterUpdate?.(update.update) !== false) this.events.update(update.update);
  }

  private request(method: string, params: unknown): unknown | Promise<unknown> {
    if (method === 'fs/read_text_file' && this.hooks.readTextFile) return this.hooks.readTextFile(params);
    if (method !== 'session/request_permission') throw new AcpRpcError(-32601, `Unsupported ACP client method: ${method}`);
    const request = permissionSchema.parse(params);
    if (request.sessionId !== this.sessionId) throw new AcpRpcError(-32602, 'Permission requested for another session');
    if (!this.promptActive || this.turnCancelled) return { outcome: { outcome: 'cancelled' } };
    const policy = this.hooks.permissionPolicy?.(request);
    if (policy) return { outcome: policy };
    // Native JSON-RPC string IDs have no length bound; UI permission IDs do.
    const requestId = `acp-permission-${this.permissionPrefix}-${++this.permissionSerial}`;
    const ask = this.hooks.permissionAsk?.(request);
    if (ask && 'refused' in ask) {
      this.events.notice(ask.refused);
      return { outcome: { outcome: 'cancelled' } };
    }
    return new Promise(resolve => {
      this.permissions.set(requestId, { request, resolve, ...(ask ? { ask } : {}) });
      if (ask) this.options.uiEvent?.({ type: 'ask.requested', requestId, questions: ask.questions });
      else this.options.uiEvent?.({ type: 'permission.requested', requestId, itemId: request.toolCall.toolCallId,
        title: request.toolCall.title ?? 'Tool permission',
        options: request.options.map(option => ({ id: option.optionId, label: option.name, kind: option.kind })),
      });
    });
  }

  private cancelPermissions(): void {
    for (const [requestId, pending] of this.permissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      if (!pending.ask) this.options.uiEvent?.({ type: 'permission.resolved', requestId, reason: 'cancelled' });
    }
    this.permissions.clear();
  }
}
