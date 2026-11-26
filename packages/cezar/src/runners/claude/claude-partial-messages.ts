import type { UiEvent, UiMessageItem, UiReasoningItem } from '@hearsay-tools/squawk/plugin';
import type { ClaudeUiMapperState, ClaudeUiMapping } from './claude-ui-mapper.ts';

type StreamItem = UiMessageItem | UiReasoningItem;
interface Chunk { readonly text: string; readonly previous: Chunk | undefined }
interface StreamBlock {
  readonly kind: 'text' | 'thinking';
  readonly item: StreamItem | undefined;
  readonly chunks: Chunk | undefined;
  readonly completed: boolean;
  readonly reconciled: boolean;
}
export interface ClaudePartialState {
  readonly streamMessageId: string | undefined;
  readonly streamBlocks: ReadonlyMap<number, StreamBlock>;
  readonly stoppedStreamBlocks: ReadonlyMap<number, StreamBlock>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function blockText(block: StreamBlock): string {
  const chunks: string[] = [];
  for (let chunk = block.chunks; chunk; chunk = chunk.previous) chunks.push(chunk.text);
  return chunks.reverse().join('');
}

/** Complete only open items; stopped blocks retain small reconciliation records. */
export function completeClaudeStreams(state: ClaudeUiMapperState): UiEvent[] {
  const events: UiEvent[] = [];
  for (const block of state.streamBlocks.values()) {
    if (block.item && !block.completed) events.push({ type: 'item.completed', item: { ...block.item, text: blockText(block) } });
  }
  return events;
}

/** Flush a final snapshot even when process teardown produced no result frame. */
export function closeClaudeStreams(state: ClaudeUiMapperState): ClaudeUiMapping {
  return {
    events: completeClaudeStreams(state),
    state: { ...state, streamMessageId: undefined, streamBlocks: new Map(), stoppedStreamBlocks: new Map() },
  };
}

function startBlock(event: Record<string, unknown>, state: ClaudeUiMapperState): ClaudeUiMapping {
  const raw = event.content_block;
  if (!record(raw) || (raw.type !== 'text' && raw.type !== 'thinking')) return { events: [], state };
  const index = event.index as number;
  if (state.streamBlocks.has(index) || state.stoppedStreamBlocks.has(index)) return { events: [], state };
  const initial = raw.type === 'text' ? raw.text : raw.thinking;
  const text = typeof initial === 'string' ? initial : '';
  const started = raw.type === 'text' || text.trim() !== '';
  const itemSeq = state.itemSeq + Number(started);
  const item: StreamItem | undefined = !started ? undefined : raw.type === 'text'
    ? { kind: 'message', id: `item_${itemSeq}`, role: 'assistant', text }
    : { kind: 'reasoning', id: `item_${itemSeq}`, text };
  const block: StreamBlock = { kind: raw.type, item, chunks: { text, previous: undefined }, completed: false, reconciled: false };
  return {
    events: item ? [{ type: 'item.started', item }] : [],
    state: { ...state, itemSeq, streamBlocks: new Map(state.streamBlocks).set(index, block), sawAssistantText: state.sawAssistantText || (raw.type === 'text' && text.length > 0) },
  };
}

function deltaText(delta: unknown, kind: StreamBlock['kind']): string | undefined {
  if (!record(delta)) return undefined;
  const value = kind === 'text' && delta.type === 'text_delta' ? delta.text
    : kind === 'thinking' && delta.type === 'thinking_delta' ? delta.thinking : undefined;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function updateBlock(event: Record<string, unknown>, state: ClaudeUiMapperState): ClaudeUiMapping {
  const index = event.index as number;
  const block = state.streamBlocks.get(index);
  if (!block || block.completed) return { events: [], state };
  if (event.type === 'content_block_stop') return stopBlock(index, block, state);
  const text = deltaText(event.delta, block.kind);
  if (text === undefined) return { events: [], state };
  const chunks = { text, previous: block.chunks };
  // Keep whitespace until the first visible thinking chunk, without minting a blank item.
  const started = !block.item && text.trim() !== '';
  const itemSeq = state.itemSeq + Number(started);
  const item = block.item ?? (started ? { kind: 'reasoning' as const, id: `item_${itemSeq}`, text: blockText(block) } : undefined);
  const events: UiEvent[] = [];
  if (started && item) events.push({ type: 'item.started', item });
  if (item) events.push({ type: 'item.delta', itemId: item.id, field: 'text', delta: text });
  return { events, state: { ...state, itemSeq, streamBlocks: new Map(state.streamBlocks).set(index, { ...block, item, chunks }), sawAssistantText: state.sawAssistantText || block.kind === 'text' } };
}

function stopBlock(index: number, block: StreamBlock, state: ClaudeUiMapperState): ClaudeUiMapping {
  const item = block.item ? { ...block.item, text: blockText(block) } : undefined;
  const streamBlocks = new Map(state.streamBlocks);
  streamBlocks.delete(index);
  return {
    events: item ? [{ type: 'item.completed', item }] : [],
    state: { ...state, streamBlocks, stoppedStreamBlocks: new Map(state.stoppedStreamBlocks).set(index, { ...block, item: undefined, chunks: undefined, completed: true }) },
  };
}

export function mapClaudePartial(msg: Record<string, unknown>, state: ClaudeUiMapperState): ClaudeUiMapping {
  if (msg.parent_tool_use_id != null && msg.parent_tool_use_id !== '') return { events: [], state };
  const event = msg.event;
  if (!record(event)) return { events: [], state };
  if (event.type === 'message_start') {
    if (!record(event.message) || typeof event.message.id !== 'string') return { events: [], state };
    return { events: completeClaudeStreams(state), state: { ...state, streamMessageId: event.message.id, streamBlocks: new Map(), stoppedStreamBlocks: new Map() } };
  }
  if (!Number.isInteger(event.index) || (event.index as number) < 0) return { events: [], state };
  if (event.type === 'content_block_start') return startBlock(event, state);
  if (event.type === 'content_block_delta' || event.type === 'content_block_stop') return updateBlock(event, state);
  return { events: [], state };
}

/** CLI 2.1.332 emits one assistant frame per block, BEFORE its block-stop event.
 * Match each singleton to the next unreconciled block of that kind, not index zero.
 */
export function reconcileClaudeAssistant(msg: Record<string, unknown>, state: ClaudeUiMapperState): { msg: Record<string, unknown>; state: ClaudeUiMapperState } {
  if (msg.parent_tool_use_id != null && msg.parent_tool_use_id !== '') return { msg, state };
  if (!record(msg.message) || msg.message.id !== state.streamMessageId || !Array.isArray(msg.message.content)) return { msg, state };
  const blocks = new Map([...state.stoppedStreamBlocks, ...state.streamBlocks]);
  const content = msg.message.content.filter(raw => {
    if (!record(raw)) return true;
    const match = [...blocks].find(([, block]) => !block.reconciled && block.kind === raw.type);
    if (!match) return true;
    const [index, block] = match;
    const text = block.kind === 'text' ? raw.text : raw.thinking;
    if (typeof text !== 'string') return true;
    if (!block.item && !block.completed && text.trim() !== '') return true;
    blocks.set(index, { ...block, reconciled: true, chunks: block.completed ? undefined : { text, previous: undefined } });
    return false;
  });
  const streamBlocks = new Map([...blocks].filter(([, block]) => !block.completed));
  const stoppedStreamBlocks = new Map([...blocks].filter(([, block]) => block.completed));
  return { msg: { ...msg, message: { ...msg.message, content } }, state: { ...state, streamBlocks, stoppedStreamBlocks } };
}
