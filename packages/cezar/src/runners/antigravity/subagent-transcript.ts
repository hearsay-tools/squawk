import type { UiEvent, UiMessageItem, UiReasoningItem, UiToolItem } from '@hearsay-tools/squawk/plugin';
import { antigravityTranscriptTool } from './tool-normalization.ts';
import {
  BoundedJsonlTailer,
  NOT_RESULT_ROW_TYPES,
  TRANSCRIPT_MAX_FLUSH_CHUNKS,
  TRANSCRIPT_READ_BYTES,
  boundTranscriptOutput,
  transcriptCallKey,
  transcriptHookItem,
  transcriptResultText,
  transcriptRowSchema,
  type TranscriptRow,
} from './transcript-tailer.ts';

const POLL_MS = 250;
const MAX_CHILD_TRANSCRIPTS = 32;

interface ChildState {
  readonly childId: string;
  readonly parentItemId: string;
  readonly tailer: BoundedJsonlTailer;
  readonly planned: Map<number, { name: string; args: unknown }>;
  readonly seenSteps: Set<number>;
  closed: boolean;
}

/**
 * Pure mapper for a single child subagent's `transcript_full.jsonl` rows into nested `UiEvent`s
 * carrying `parentItemId`. Deduplicates tool calls that were already forwarded live over ACP.
 */
export function mapChildTranscriptRow(
  value: unknown,
  childId: string,
  parentItemId: string,
  planned: Map<number, { name: string; args: unknown }>,
  seenSteps: Set<number>,
  consumeWireTool: (name: string, args: unknown) => boolean,
): UiEvent[] {
  const parsed = transcriptRowSchema.safeParse(value);
  if (!parsed.success) return [];
  const row = parsed.data;
  if (seenSteps.has(row.step_index)) return [];
  seenSteps.add(row.step_index);
  if (row.type === 'PLANNER_RESPONSE') return mapPlannerRow(row, childId, parentItemId, planned);
  if (row.type === 'SYSTEM_MESSAGE') {
    const hook = transcriptHookItem(row, `${childId}:`);
    return hook ? [{ type: 'item.completed', item: { ...hook, parentItemId } }] : [];
  }
  if (NOT_RESULT_ROW_TYPES.has(row.type)) return [];
  const call = planned.get(row.step_index);
  if (!call) return [];
  planned.delete(row.step_index);
  if (consumeWireTool(call.name, call.args)) return [];
  const output = transcriptResultText(row);
  const item: UiToolItem = {
    kind: 'tool',
    id: `${childId}:step_${row.step_index}`,
    parentItemId,
    status: row.status === 'ERROR' ? 'failed' : 'completed',
    ...antigravityTranscriptTool(call.name, call.args),
    ...(output ? { output } : {}),
  };
  return [{ type: 'item.started', item }, { type: 'item.completed', item }];
}

function mapPlannerRow(row: TranscriptRow, childId: string, parentItemId: string, planned: Map<number, { name: string; args: unknown }>): UiEvent[] {
  const events: UiEvent[] = [];
  const thinking = row.thinking?.trim();
  if (thinking) {
    const item: UiReasoningItem = { kind: 'reasoning', id: `${childId}:step_${row.step_index}:reasoning`, parentItemId, text: boundTranscriptOutput(thinking) };
    events.push({ type: 'item.started', item }, { type: 'item.completed', item });
  }
  const text = row.content?.trim();
  if (text) {
    const item: UiMessageItem = { kind: 'message', id: `${childId}:step_${row.step_index}:message`, role: 'assistant', parentItemId, text: boundTranscriptOutput(text) };
    events.push({ type: 'item.started', item }, { type: 'item.completed', item });
  }
  row.tool_calls?.forEach((call, index) => {
    planned.set(row.step_index + 1 + index, { name: call.name, args: call.args });
  });
  return events;
}

/**
 * Tails spawned Antigravity child transcripts (`brain/<childId>/.system_generated/logs/transcript_full.jsonl`)
 * to surface non-prompting child steps (`read_file`, `send_message`, child thinking and replies)
 * under `parentItemId`, while skipping tool calls already forwarded on the ACP wire.
 */
export class AntigravityChildTranscripts {
  private readonly children = new Map<string, ChildState>();
  private readonly wireTools = new Map<string, Map<string, number>>();
  private readonly seenWireCallIds = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private reading: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly emit: (event: UiEvent) => void, private readonly readBytes = TRANSCRIPT_READ_BYTES) {}

  /** Records a child tool call already seen on ACP so its transcript row is not emitted twice. */
  recordWireTool(childId: string, toolCallId: string, name: string, args: unknown): void {
    if (this.seenWireCallIds.has(toolCallId)) return;
    this.seenWireCallIds.add(toolCallId);
    const id = childId.toLowerCase();
    const counts = this.wireTools.get(id) ?? new Map<string, number>();
    const key = transcriptCallKey(name, args);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    this.wireTools.set(id, counts);
  }

  /** Starts tailing a newly spawned child conversation from byte 0. */
  openChild(childId: string, parentItemId: string, path: string): void {
    const id = childId.toLowerCase();
    if (this.closed || this.children.has(id) || this.children.size >= MAX_CHILD_TRANSCRIPTS) return;
    this.children.set(id, { childId: id, parentItemId, tailer: new BoundedJsonlTailer(path, false, this.readBytes), planned: new Map(), seenSteps: new Set(), closed: false });
    this.schedule(0);
  }

  poll(): Promise<void> {
    this.reading ??= this.readAll().catch(() => {}).finally(() => { this.reading = undefined; });
    return this.reading;
  }

  /** Drains unread rows for one child (up to bounded chunks) and stops polling it. */
  async flushChild(childId: string): Promise<void> {
    const child = this.children.get(childId.toLowerCase());
    if (!child || child.closed) return;
    while (this.reading) await this.reading;
    for (let chunk = 0; chunk < TRANSCRIPT_MAX_FLUSH_CHUNKS && !this.closed && !child.closed; chunk++) {
      await this.readChild(child);
      if (!child.tailer.hasMore) break;
    }
    child.closed = true;
  }

  async flushAll(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.reading) await this.reading;
    for (const child of this.children.values()) {
      if (child.closed) continue;
      for (let chunk = 0; chunk < TRANSCRIPT_MAX_FLUSH_CHUNKS && !this.closed; chunk++) {
        await this.readChild(child);
        if (!child.tailer.hasMore) break;
      }
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const child of this.children.values()) child.closed = true;
  }

  private schedule(delay: number): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll().then(() => this.next()); }, delay);
    this.timer.unref?.();
  }

  private next(): void {
    if (!this.closed && [...this.children.values()].some(child => !child.closed)) this.schedule(POLL_MS);
  }

  private async readAll(): Promise<void> {
    for (const child of this.children.values()) {
      if (!this.closed && !child.closed) await this.readChild(child);
    }
  }

  private async readChild(child: ChildState): Promise<void> {
    const consume = (name: string, args: unknown) => {
      const counts = this.wireTools.get(child.childId);
      const key = transcriptCallKey(name, args);
      const n = counts?.get(key) ?? 0;
      if (n <= 0) return false;
      if (n === 1) counts!.delete(key); else counts!.set(key, n - 1);
      return true;
    };
    await child.tailer.readNext(row => {
      if (this.closed) return;
      for (const event of mapChildTranscriptRow(row, child.childId, child.parentItemId, child.planned, child.seenSteps, consume)) {
        this.emit(event);
      }
    });
  }
}
