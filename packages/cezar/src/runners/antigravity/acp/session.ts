import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { z, type StopReason, type TokenUsage } from '@hearsay-tools/squawk/plugin';
import { AcpEvents, type AcpEventSink } from './events.ts';
import { AcpRpcError, AcpTransport } from './transport.ts';
import { addUsage } from './usage.ts';
import { initializeSchema, permissionSchema, recordSchema, type AcpAsk, type AcpHooks, type AcpInitializeResult, type AcpPermissionRequest } from './protocol.ts';

const updateSchema = z.object({ sessionId: z.string(), update: recordSchema });
const promptResultSchema = z.object({ stopReason: z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) }).passthrough();
interface PendingPermission { request: AcpPermissionRequest; ask?: AcpAsk; resolve(value: unknown): void }
export interface AcpSessionOptions extends AcpEventSink {
  backend: string;
  clientInfo: { name: string; version: string };
  hooks?: AcpHooks;
  onActivity?: () => void;
  /** Runs after a `session/request_permission` response has been written to the transport. */
  onPermissionResolved?: () => void;
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
  private permissionResolutions = 0;
  private readonly permissionPrefix = randomUUID();
  private closed = false;
  private promptOwner: symbol | undefined;
  private readonly prompts = new Set<symbol>();
  private get promptActive(): boolean { return this.promptOwner !== undefined; }
  private turnCancelled = false;
  private turnUsage: TokenUsage | undefined;
  private readonly acknowledgements = new Map<symbol, () => void>();
  /** The prompt that opened the running turn, until the turn's first agent work acknowledges it. */
  private turnOpener: symbol | undefined;

  constructor(streams: { input: Writable; output: Readable }, private readonly options: AcpSessionOptions) {
    this.hooks = options.hooks ?? {};
    this.events = new AcpEvents(options, this.hooks);
    this.transport = new AcpTransport(streams, {
      notification: (method, params) => this.notification(method, params),
      request: (method, params) => this.request(method, params),
      answered: method => {
        if (method !== 'session/request_permission' || this.closed) return;
        this.permissionResolutions++;
        this.options.onPermissionResolved?.();
      },
      notice: message => this.events.notice(message),
      ...(options.onActivity ? { activity: options.onActivity } : {}),
    });
    void this.transport.completion.then(() => { this.closed = true; this.cancelPermissions(); this.events.flush(); });
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

  /** ACP sends no turn-start frame, and a prompt's response ends its turn. The agent's first work
   * update in the turn this prompt opened is the agent taking it: `onAcknowledged` runs then, or at
   * the response when no work came first. Work that reports a provider failure acknowledges nothing;
   * later work in the turn clears that failure and acknowledges it. A prompt that joins an
   * agent-started turn is acknowledged only by its response. */
  async prompt(content: readonly Record<string, unknown>[], onAcknowledged?: () => void): Promise<z.infer<typeof promptResultSchema>> {
    if (this.promptActive) throw new Error('ACP prompt already active');
    return this.requestPrompt(content, onAcknowledged);
  }

  /** Steering adds input to the running turn. The turn is one logical turn: if the running prompt
   * answers first, the steered prompt carries the turn and its response ends it. That early answer
   * is the agent taking the steer: `onAcknowledged` runs then, or at the steer's own response. */
  async steer(content: readonly Record<string, unknown>[], onAcknowledged?: () => void): Promise<void> {
    if (!this.promptActive) throw new Error('ACP steering requires an active prompt');
    await this.requestPrompt(content, onAcknowledged);
  }

  /** A prompt is open: new input steers into it. */
  get promptOpen(): boolean { return this.promptActive; }

  /** An agent-started turn is open: the agent works on its own, with no prompt carrying it. */
  get agentWorking(): boolean { return this.events.agentTurn; }

  /** At least one native permission or ask request is waiting for an answer. */
  get hasPendingPermission(): boolean { return this.permissions.size > 0; }

  /** Count of native permission requests whose response has been written to the wire. */
  get permissionResolutionCount(): number { return this.permissionResolutions; }

  private async requestPrompt(content: readonly Record<string, unknown>[], onAcknowledged?: () => void): Promise<z.infer<typeof promptResultSchema>> {
    const sessionId = this.requireSession();
    const token = Symbol('prompt');
    this.prompts.add(token);
    if (onAcknowledged) this.acknowledgements.set(token, onAcknowledged);
    if (!this.promptOwner) this.beginPrompt(token);
    let result: z.infer<typeof promptResultSchema>;
    try {
      result = promptResultSchema.parse(await this.transport.request('session/prompt', { sessionId, prompt: content }));
      const failure = this.promptOwner === token ? this.events.turnFailure : undefined;
      if (failure) throw new Error(failure);
    } catch (error) {
      this.acknowledgements.delete(token);
      if (this.turnOpener === token) this.turnOpener = undefined;
      this.finishPrompt(token, this.turnCancelled ? 'cancelled' : 'error');
      throw error;
    }
    // A turn opener no work acknowledged is acknowledged after its turn ends, as its response ends it.
    // Clear it before the turn end: a turn-end listener may open the next turn at once.
    const unacknowledgedOpener = this.turnOpener === token;
    if (unacknowledgedOpener) this.turnOpener = undefined;
    else this.acknowledge(token);
    const reason: StopReason = result.stopReason === 'max_turn_requests' ? 'max_tokens' : result.stopReason;
    this.finishPrompt(token, reason, this.hooks.normalizeUsage?.(result.usage));
    if (unacknowledgedOpener) this.acknowledge(token);
    return result;
  }

  private acknowledge(token: symbol): void {
    const acknowledged = this.acknowledgements.get(token);
    this.acknowledgements.delete(token);
    acknowledged?.();
  }

  private beginPrompt(token: symbol): void {
    this.promptOwner = token;
    this.turnCancelled = false;
    this.turnUsage = undefined;
    if (this.events.agentTurn) { this.events.adopt(); this.turnOpener = undefined; }
    else { this.events.begin(); this.turnOpener = token; }
  }

  private acknowledgeOnWork(): void {
    const token = this.turnOpener;
    if (!token || token !== this.promptOwner || this.events.turnFailure) return;
    this.turnOpener = undefined;
    this.acknowledge(token);
  }

  private finishPrompt(token: symbol, reason: StopReason, usage?: TokenUsage): void {
    this.prompts.delete(token);
    if (usage) this.turnUsage = addUsage(this.turnUsage, usage);
    if (this.promptOwner !== token) return;
    const next = this.prompts.values().next().value;
    // A steer still pending carries the running turn: the agent ended this prompt to read it.
    if (next && reason === 'end_turn' && !this.closed) { this.promptOwner = next; this.acknowledge(next); return; }
    this.cancelPermissions();
    // A turn-end listener may send input at once: it must find no prompt open, and open its own turn.
    const carried = this.turnUsage;
    this.promptOwner = undefined;
    this.turnUsage = undefined;
    this.events.finish(reason, carried);
    const waiting = this.prompts.values().next().value;
    if (waiting && !this.promptOwner && !this.closed) this.beginPrompt(waiting);
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

  close(): void { this.closed = true; this.turnCancelled = true; this.cancelPermissions(); this.events.flush(); this.transport.close(); }

  updateHeldTool(id: string, output: string): void {
    this.events.updateHeldTool(id, output);
  }

  completeHeldTool(id: string, status: 'completed' | 'failed' | 'declined', output?: string): void {
    this.events.completeHeldTool(id, status, output);
  }

  reparentTools(match: (id: string) => boolean, parentItemId: string): void {
    this.events.reparentTools(match, parentItemId);
  }

  private requireSession(): string {
    if (!this.sessionId) throw new Error('ACP session is not open');
    return this.sessionId;
  }

  private notification(method: string, params: unknown): void {
    if (method !== 'session/update') return;
    const update = updateSchema.parse(params);
    if (this.opening) this.earlyUpdates.push(update);
    else if (update.sessionId === this.sessionId && this.hooks.filterUpdate?.(update.update) !== false && this.events.update(update.update)) this.acknowledgeOnWork();
  }

  private request(method: string, params: unknown): unknown | Promise<unknown> {
    if (method === 'fs/read_text_file' && this.hooks.readTextFile) return this.hooks.readTextFile(params);
    if (method !== 'session/request_permission') throw new AcpRpcError(-32601, `Unsupported ACP client method: ${method}`);
    const request = permissionSchema.parse(params);
    if (request.sessionId !== this.sessionId) throw new AcpRpcError(-32602, 'Permission requested for another session');
    // An agent-started turn asks too: its idle session woke on its own.
    if (!(this.promptActive || this.events.turnOpen) || this.turnCancelled) return { outcome: { outcome: 'cancelled' } };
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
