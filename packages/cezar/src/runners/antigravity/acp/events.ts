import { z, type AgentEvent, type UiEvent, type UiMessageItem, type UiReasoningItem, type UiToolItem, type StopReason, type TokenUsage } from '@hearsay-tools/squawk/plugin';
import type { AcpHooks } from './protocol.ts';

const toolSchema = z.object({
  toolCallId: z.string(), title: z.string().nullish(), name: z.string().nullish(),
  kind: z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']).catch('other').nullish(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).nullish().catch(undefined),
  rawInput: z.unknown().optional(), rawOutput: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), content: z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional() }).optional(),
    path: z.string().optional(), oldText: z.string().nullable().optional(), newText: z.string().optional(),
  }).passthrough()).nullish(),
  locations: z.array(z.object({ path: z.string(), line: z.number().optional() })).nullish(),
}).passthrough();
type AcpTool = z.infer<typeof toolSchema>;
const planStatusSchema = z.enum(['pending', 'in_progress', 'completed']);
/** Updates that are the agent's own work, as opposed to session metadata. */
const WORK_UPDATES: ReadonlySet<string> = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);
const planSchema = z.array(z.object({ content: z.string(), status: planStatusSchema.catch('pending'), priority: z.enum(['high', 'medium', 'low']) }));
export interface AcpEventSink { event?(event: AgentEvent): void; uiEvent?(event: UiEvent): void }

/** Stateful ACP-v1 -> Squawk v1/v2 mapping. No provider names or tool arguments live here. */
export class AcpEvents {
  private serial = 0;
  private turnId: string | undefined;
  /** The open turn was started by the agent's own work, and no prompt carries it yet. */
  private agentStarted = false;
  /** The kind of the open turn's latest work update. */
  private lastWork: string | undefined;
  /** A provider failure the open turn's last work reported as text. */
  private failure: string | undefined;
  private block: UiMessageItem | UiReasoningItem | undefined;
  /** How much of the open message block v1 `text` has carried. */
  private released = 0;
  private tools = new Map<string, UiToolItem>();
  constructor(private readonly sink: AcpEventSink, private readonly hooks: AcpHooks) {}

  get turnOpen(): boolean { return this.turnId !== undefined; }
  /** The provider failure of the open turn, if its text reported one. */
  get turnFailure(): string | undefined { return this.failure; }

  begin(): string {
    if (this.turnId) throw new Error('ACP prompt already active');
    this.turnId = `acp-turn-${++this.serial}`;
    this.lastWork = undefined;
    this.sink.uiEvent?.({ type: 'turn.started', turnId: this.turnId });
    return this.turnId;
  }

  /** A prompt joins the agent-started turn that is open; its response ends that turn. */
  adopt(): void {
    if (!this.agentStarted) throw new Error('ACP has no agent-started turn to adopt');
    this.agentStarted = false;
  }

  /** The open turn was started by the agent and no prompt carries it. */
  get agentTurn(): boolean { return this.agentStarted; }

  finish(stopReason: StopReason, usage?: TokenUsage): void {
    this.flush();
    if (!this.turnId) return;
    const reason = this.failure ? 'error' : stopReason;
    if (this.failure) this.sink.event?.({ type: 'error', message: this.failure });
    this.finishTools(reason);
    // A turn-end listener sees the turn closed: it may start the next one or close the session.
    const turnId = this.turnId;
    this.turnId = undefined; this.agentStarted = false; this.failure = undefined;
    this.sink.uiEvent?.({ type: 'turn.completed', turnId, stopReason: reason, ...(usage ? { usage } : {}) });
    this.sink.event?.({ type: 'turn-end' });
  }

  /** True when the update was the agent's own work inside a turn. */
  update(update: Record<string, unknown>): boolean {
    try {
      if (this.closedTool(update)) return false;
      const work = WORK_UPDATES.has(update.sessionUpdate as string);
      if (work && !this.turnId && this.hooks.agentWorkEnds) { this.begin(); this.agentStarted = true; }
      // A failure counts only as the whole message and the turn's last work: later work clears it.
      if (work) this.failure = this.turnId && this.block?.kind !== 'message' ? this.hooks.updateError?.(update) : undefined;
      this.mapUpdate(update);
      const previous = this.lastWork;
      if (work) this.lastWork = update.sessionUpdate as string;
      if (this.agentStarted && this.hooks.agentWorkEnds?.(update, previous)) this.finish('end_turn');
      return work;
    } catch { this.notice('ACP ignored malformed session/update'); return false; }
  }

  /** A late update for a tool already closed (a failed call the agent reports after cancel). */
  private closedTool(update: Record<string, unknown>): boolean {
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return false;
    const status = this.tools.get(String(update.toolCallId))?.status;
    return status === 'completed' || status === 'failed';
  }


  notice(message: string): void {
    this.sink.event?.({ type: 'note', message });
    this.sink.uiEvent?.({ type: 'session.error', message, fatal: false });
  }

  /** A mapper can fold one frame without mutating its caller's state. */
  fork(sink: AcpEventSink): AcpEvents {
    const next = new AcpEvents(sink, this.hooks);
    next.serial = this.serial; next.turnId = this.turnId;
    next.agentStarted = this.agentStarted; next.lastWork = this.lastWork; next.failure = this.failure;
    next.block = this.block ? { ...this.block } : undefined; next.released = this.released;
    // Updates replace tool snapshots; their nested input/output values are never mutated.
    next.tools = new Map(this.tools);
    return next;
  }

  private mapUpdate(update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': this.content(update.content, 'message'); break;
      case 'agent_thought_chunk': this.content(update.content, 'reasoning'); break;
      case 'tool_call': case 'tool_call_update': this.tool(update); break;
      case 'plan': this.plan(update.entries); break;
      case 'usage_update': this.usage(update); break;
      case 'config_option_update': this.hooks.normalizeOptions?.(update.configOptions); break;
      case 'available_commands_update': break; // Native command catalog, not a fault.
      case 'session_info_update': break; // A native session title.
      case 'current_mode_update': break; // The native mode the session/set_config_option call chose.
      default: this.notice('ACP ignored unsupported session/update');
    }
  }

  private content(value: unknown, kind: 'message' | 'reasoning'): void {
    const content = z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional() }).parse(value);
    if (content.type !== 'text' && content.type !== 'image') {
      this.notice(`ACP ignored unsupported content type: ${content.type}`);
      return;
    }
    if (content.type === 'image' && content.data && content.mimeType) {
      this.sink.event?.({ type: 'image', mediaType: content.mimeType, data: content.data });
      this.sink.uiEvent?.({ type: 'image', mediaType: content.mimeType, data: content.data });
    }
    if (content.type !== 'text' || content.text === undefined) return;
    if (this.block?.kind !== kind) {
      this.flush();
      this.block = kind === 'message'
        ? { kind, id: `acp-item-${++this.serial}`, role: 'assistant', text: '' }
        : { kind, id: `acp-item-${++this.serial}`, text: '' };
      this.sink.uiEvent?.({ type: 'item.started', item: { ...this.block } });
    }
    this.block!.text += content.text;
    this.sink.uiEvent?.({ type: 'item.delta', itemId: this.block!.id, field: kind === 'message' ? 'text' : 'reasoning', delta: content.text });
  }

  private plan(value: unknown): void {
    const entries = planSchema.parse(value);
    const original = z.array(z.object({ status: z.unknown() })).parse(value);
    if (original.some(entry => !planStatusSchema.safeParse(entry.status).success)) this.notice('ACP normalized unknown plan status');
    this.flush();
    this.sink.uiEvent?.({ type: 'plan.updated', entries });
  }

  /** Close the open block, then release its held v1 text: the cockpit has the whole v2 item
   *  before its v1 twin lands. The session also flushes when the wire closes: an agent-started
   *  turn has no prompt response to finish it. */
  flush(): void {
    const block = this.block;
    const held = block?.kind === 'message' ? block.text.slice(this.released) : '';
    // State settles before the sinks run: a listener may close the session, which flushes again.
    this.block = undefined; this.released = 0;
    if (block) this.sink.uiEvent?.({ type: 'item.completed', item: { ...block } });
    if (held) this.sink.event?.({ type: 'text', text: held });
  }

  /** v1 `text` carries a message block whole, not chunk by chunk. A usage update releases the
   *  open block's text up to `end` early and keeps the block open. */
  private release(end: number): void {
    if (this.block?.kind !== 'message' || end <= this.released) return;
    const text = this.block.text.slice(this.released, end);
    this.released = end;
    this.sink.event?.({ type: 'text', text });
  }

  private finishTools(reason: StopReason): void {
    // A wire whose idle session wakes on its own keeps a call running past a normal turn end: a
    // background command, a timer or a question completes in a later turn.
    if (this.hooks.agentWorkEnds && reason !== 'cancelled' && reason !== 'error') return;
    for (const [id, tool] of this.tools) {
      if (tool.status === 'completed' || tool.status === 'failed') continue;
      const item: UiToolItem = { ...tool, status: 'failed', output: tool.output || (reason === 'cancelled' ? 'Cancelled' : 'Turn ended before the tool completed') };
      this.tools.set(id, item);
      this.sink.event?.({ type: 'tool-result', toolCallId: id, result: item.output!, isError: true });
      this.sink.uiEvent?.({ type: 'item.completed', item });
    }
  }

  private usage(update: Record<string, unknown>): void {
    const usage = z.object({ used: z.number().nonnegative(), size: z.number().nonnegative(),
      cost: z.object({ amount: z.number().nonnegative(), currency: z.string() }).optional(),
    }).parse(update);
    const cost = usage.cost?.currency === 'USD' ? usage.cost.amount : undefined;
    if (this.block?.kind === 'message') this.release(markerSafeEnd(this.block.text, this.released));
    this.sink.event?.({ type: 'token-usage', tokensUsed: usage.used });
    if (cost !== undefined) this.sink.event?.({ type: 'cost', usd: cost });
    this.sink.uiEvent?.({ type: 'usage.updated', usage: { input: 0, output: 0, total: usage.used, contextWindow: usage.size }, ...(cost === undefined ? {} : { costUsd: cost }) });
  }

  private tool(update: Record<string, unknown>): void {
    this.flush();
    const wire = toolSchema.parse(update);
    if (wire.kind !== update.kind || wire.status !== update.status) this.notice('ACP normalized unknown tool metadata');
    const previous = this.tools.get(wire.toolCallId);
    const item: UiToolItem = { ...toolItem(wire, previous),
      ...this.hooks.normalizeTool?.(update, previous),
    };
    this.tools.set(item.id, item);
    if (!previous) this.sink.event?.({ type: 'tool-call', id: item.id, tool: item.name, input: item.input });
    const complete = item.status === 'completed' || item.status === 'failed';
    if (!previous) this.sink.uiEvent?.({ type: 'item.started', item: { ...item } });
    if (complete && previous?.status !== item.status) {
      this.sink.event?.({ type: 'tool-result', toolCallId: item.id, result: item.output ?? '', isError: item.status === 'failed' });
      this.sink.uiEvent?.({ type: 'item.completed', item: { ...item } });
    } else if (previous) this.sink.uiEvent?.({ type: 'item.updated', item: { ...item } });
    this.toolImages(wire, item.id);
  }

  private toolImages(wire: AcpTool, itemId: string): void {
    for (const entry of wire.content ?? []) {
      const content = entry.content;
      if (content?.type !== 'image' || !content.data || !content.mimeType) continue;
      this.sink.event?.({ type: 'image', mediaType: content.mimeType, data: content.data });
      this.sink.uiEvent?.({ type: 'image', itemId, mediaType: content.mimeType, data: content.data });
    }
  }
}

const MARKER = 'CEZ:';

/**
 * Where an early v1 release may end. The server strips protocol markers per v1 event, line by line
 * (`stripTaskMarkers`), and joins events into the turn text with a newline (`appendTurnText`).
 * So an open line that holds, or may still grow into, `CEZ:` is held whole until it ends: a
 * split would leak a marker's tail, or turn prose before `CEZ:` into a marker line.
 */
function markerSafeEnd(text: string, released: number): number {
  const lineStart = text.lastIndexOf('\n') + 1;
  const line = text.slice(lineStart);
  let at = line.indexOf(MARKER);
  for (let length = MARKER.length - 1; at < 0 && length > 0; length--) {
    if (line.endsWith(MARKER.slice(0, length))) at = line.length - length;
  }
  return at < 0 ? text.length : Math.max(released, lineStart);
}

function toolItem(wire: AcpTool, previous: UiToolItem | undefined): UiToolItem {
  return {
    kind: 'tool', id: wire.toolCallId, ...previous,
    name: wire.name ?? previous?.name ?? wire.title ?? 'tool',
    title: wire.title ?? previous?.title ?? 'Tool call',
    toolKind: wire.kind === 'switch_mode' ? 'other' : wire.kind ?? previous?.toolKind ?? 'other',
    status: wire.status === 'in_progress' ? 'running' : wire.status ?? previous?.status ?? 'pending',
    ...(wire.rawInput == null ? {} : { input: wire.rawInput }),
    ...toolContent(wire),
    ...(wire.locations == null ? {} : { locations: wire.locations.map(location => ({ path: location.path,
      ...(location.line === undefined ? {} : { line: location.line }),
    })) }),
  };
}

function toolContent(wire: AcpTool): Pick<UiToolItem, 'output' | 'diffs'> {
  const fields: Pick<UiToolItem, 'output' | 'diffs'> = {};
  if (wire.content) {
    fields.output = wire.content.flatMap(c => c.content?.type === 'text' ? [c.content.text ?? ''] : []).join('\n');
    fields.diffs = wire.content.flatMap(c => c.type === 'diff' && c.path && c.newText !== undefined
      ? [{ path: c.path, oldText: c.oldText ?? null, newText: c.newText }] : []);
  }
  if (wire.rawOutput != null) fields.output = typeof wire.rawOutput === 'string' ? wire.rawOutput : JSON.stringify(wire.rawOutput);
  return fields;
}
