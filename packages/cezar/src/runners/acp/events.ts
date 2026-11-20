import { z } from 'zod';
import type { AgentEvent } from '../../core/agent-runner.ts';
import type { UiEvent, UiMessageItem, UiReasoningItem, UiToolItem, StopReason } from '../../core/ui-events.ts';
import type { AcpHooks } from './protocol.ts';

const toolSchema = z.object({
  toolCallId: z.string(), title: z.string().nullish(), name: z.string().nullish(),
  kind: z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']).nullish(),
  status: z.enum(['pending', 'in_progress', 'completed', 'failed']).nullish(),
  rawInput: z.unknown().optional(), rawOutput: z.unknown().optional(),
  content: z.array(z.object({ type: z.string(), content: z.object({ type: z.string(), text: z.string().optional() }).optional(),
    path: z.string().optional(), oldText: z.string().nullable().optional(), newText: z.string().optional(),
  }).passthrough()).nullish(),
  locations: z.array(z.object({ path: z.string(), line: z.number().optional() })).nullish(),
}).passthrough();
type AcpTool = z.infer<typeof toolSchema>;
const planSchema = z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed']), priority: z.enum(['high', 'medium', 'low']) }));
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

  finish(stopReason: StopReason): void {
    this.flush();
    if (!this.turnId) return;
    this.sink.uiEvent?.({ type: 'turn.completed', turnId: this.turnId, stopReason });
    this.turnId = undefined;
    this.sink.event?.({ type: 'turn-end' });
  }

  update(update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': this.content(update.content, 'message'); break;
      case 'agent_thought_chunk': this.content(update.content, 'reasoning'); break;
      case 'tool_call': case 'tool_call_update': this.tool(update); break;
      case 'plan': this.flush(); this.sink.uiEvent?.({ type: 'plan.updated', entries: planSchema.parse(update.entries) }); break;
      case 'usage_update': this.usage(update); break;
      case 'config_option_update': this.hooks.normalizeOptions?.(update.configOptions); break;
    }
  }

  private content(value: unknown, kind: 'message' | 'reasoning'): void {
    const content = z.object({ type: z.string(), text: z.string().optional(), data: z.string().optional(), mimeType: z.string().optional() }).parse(value);
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
