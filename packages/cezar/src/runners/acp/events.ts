import { z } from 'zod';
import type { AgentEvent } from '../../core/agent-runner.ts';
import type { UiEvent, UiMessageItem, UiReasoningItem, UiToolItem, StopReason, TokenUsage } from '../../core/ui-events.ts';
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
const planSchema = z.array(z.object({ content: z.string(), status: planStatusSchema.catch('pending'), priority: z.enum(['high', 'medium', 'low']) }));
export interface AcpEventSink { event?(event: AgentEvent): void; uiEvent?(event: UiEvent): void }

/** Stateful ACP-v1 -> Squawk v1/v2 mapping. No provider names or tool arguments live here. */
export class AcpEvents {
  private serial = 0;
  private turnId: string | undefined;
  private block: UiMessageItem | UiReasoningItem | undefined;
  private tools = new Map<string, UiToolItem>();
  constructor(private readonly sink: AcpEventSink, private readonly hooks: AcpHooks) {}

  begin(): string {
    if (this.turnId) throw new Error('ACP prompt already active');
    this.turnId = `acp-turn-${++this.serial}`;
    this.sink.uiEvent?.({ type: 'turn.started', turnId: this.turnId });
    return this.turnId;
  }

  finish(stopReason: StopReason, usage?: TokenUsage): void {
    this.flush();
    if (!this.turnId) return;
    this.sink.uiEvent?.({ type: 'turn.completed', turnId: this.turnId, stopReason, ...(usage ? { usage } : {}) });
    this.turnId = undefined;
    this.sink.event?.({ type: 'turn-end' });
  }

  update(update: Record<string, unknown>): void {
    try { this.mapUpdate(update); }
    catch { this.notice('ACP ignored malformed session/update'); }
  }

  notice(message: string): void {
    this.sink.event?.({ type: 'note', message });
    this.sink.uiEvent?.({ type: 'session.error', message, fatal: false });
  }

  /** A mapper can fold one frame without mutating its caller's state. */
  fork(sink: AcpEventSink): AcpEvents {
    const next = new AcpEvents(sink, this.hooks);
    next.serial = this.serial; next.turnId = this.turnId;
    next.block = this.block ? structuredClone(this.block) : undefined;
    next.tools = structuredClone(this.tools);
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
    if (kind === 'message') this.sink.event?.({ type: 'text', text: content.text });
  }

  private plan(value: unknown): void {
    const entries = planSchema.parse(value);
    const original = z.array(z.object({ status: z.unknown() })).parse(value);
    if (original.some(entry => !planStatusSchema.safeParse(entry.status).success)) this.notice('ACP normalized unknown plan status');
    this.flush();
    this.sink.uiEvent?.({ type: 'plan.updated', entries });
  }

  private flush(): void {
    if (this.block) this.sink.uiEvent?.({ type: 'item.completed', item: { ...this.block } });
    this.block = undefined;
  }

  private usage(update: Record<string, unknown>): void {
    const usage = z.object({ used: z.number().nonnegative(), size: z.number().nonnegative(),
      cost: z.object({ amount: z.number().nonnegative(), currency: z.string() }).optional(),
    }).parse(update);
    const cost = usage.cost?.currency === 'USD' ? usage.cost.amount : undefined;
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
