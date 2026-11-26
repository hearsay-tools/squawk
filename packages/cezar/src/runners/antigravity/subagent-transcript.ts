import type { UiEvent, UiMessageItem, UiReasoningItem, UiToolItem } from '@hearsay-tools/squawk/plugin';
import { antigravityTranscriptTool } from './tool-normalization.ts';
import {
  BoundedJsonlTailer,
  NOT_RESULT_ROW_TYPES,
  TRANSCRIPT_MAX_FLUSH_CHUNKS,
  TRANSCRIPT_READ_BYTES,
  TranscriptPoller,
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

interface WireToolEntry {
  readonly toolCallId: string;
  readonly childId: string;
  item?: UiToolItem;
  transcriptOutput?: string;
  amended?: boolean;
}

/**
 * Pure mapper for a single child subagent's `transcript_full.jsonl` rows into nested `UiEvent`s
 * carrying `parentItemId`. Deduplicates tool calls already forwarded live over ACP while passing
 * their transcript result text to `consumeWireTool` so empty wire completions (MCP/read) recover it.
 */
export function mapChildTranscriptRow(
  value: unknown,
  childId: string,
  parentItemId: string,
  planned: Map<number, { name: string; args: unknown }>,
  seenSteps: Set<number>,
  consumeWireTool: (name: string, args: unknown, output: string) => boolean,
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
  const output = transcriptResultText(row);
  if (consumeWireTool(call.name, call.args, output)) return [];
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
 * under `parentItemId`, deduplicate ACP-forwarded child tool calls, and recover outputs for
 * forwarded child calls whose ACP completion carried none (MCP/read).
 */
export class AntigravityChildTranscripts {
  private readonly children = new Map<string, ChildState>();
  private readonly wireTools = new Map<string, Map<string, WireToolEntry[]>>();
  private readonly wireById = new Map<string, WireToolEntry>();
  private readonly poller: TranscriptPoller;

  constructor(private readonly emit: (event: UiEvent) => void, private readonly readBytes = TRANSCRIPT_READ_BYTES) {
    this.poller = new TranscriptPoller(
      () => this.readAll(),
      () => [...this.children.values()].some(child => !child.closed),
      POLL_MS,
    );
  }

  /** Records a child tool call already seen on ACP so its transcript row is deduplicated and matched. */
  recordWireTool(childId: string, toolCallId: string, name: string, args: unknown): void {
    if (this.wireById.has(toolCallId)) return;
    const id = childId.toLowerCase();
    const entry: WireToolEntry = { toolCallId, childId: id };
    this.wireById.set(toolCallId, entry);
    const byKey = this.wireTools.get(id) ?? new Map<string, WireToolEntry[]>();
    const key = transcriptCallKey(name, args);
    byKey.set(key, [...byKey.get(key) ?? [], entry]);
    this.wireTools.set(id, byKey);
  }

  /** Notes a completed ACP-forwarded child tool; if it carried no output, amends from child transcript. */
  completedWireTool(childId: string, item: UiToolItem): void {
    const entry = this.wireById.get(item.id);
    if (!entry) return;
    entry.item = item;
    if (item.output || entry.amended) return;
    const child = this.children.get(childId.toLowerCase());
    if (entry.transcriptOutput) {
      this.amendWireOutput(entry, child?.parentItemId ?? item.parentItemId, entry.transcriptOutput);
    } else if (child && !child.closed) {
      this.poller.schedule(0);
    }
  }

  /** Starts tailing a newly spawned child conversation from byte 0. */
  openChild(childId: string, parentItemId: string, path: string): void {
    const id = childId.toLowerCase();
    if (this.poller.closed || this.children.has(id) || this.children.size >= MAX_CHILD_TRANSCRIPTS) return;
    this.children.set(id, { childId: id, parentItemId, tailer: new BoundedJsonlTailer(path, false, this.readBytes), planned: new Map(), seenSteps: new Set(), closed: false });
    this.poller.schedule(0);
  }

  poll(): Promise<void> { return this.poller.poll(); }

  /** Drains unread rows for a killed child and stops polling it. */
  async closeChild(childId: string): Promise<void> {
    const child = this.children.get(childId.toLowerCase());
    if (!child || child.closed) return;
    await this.poller.waitIdle();
    await this.drainChild(child);
    child.closed = true;
  }

  async flushAll(): Promise<void> {
    await this.poller.waitIdle();
    for (const child of this.children.values()) {
      if (!child.closed) await this.drainChild(child);
    }
  }

  close(): void {
    this.poller.close();
    for (const child of this.children.values()) child.closed = true;
  }

  private async drainChild(child: ChildState): Promise<void> {
    for (let chunk = 0; chunk < TRANSCRIPT_MAX_FLUSH_CHUNKS && !this.poller.closed && !child.closed; chunk++) {
      await this.readChild(child);
      if (!child.tailer.hasMore) break;
    }
  }

  private async readAll(): Promise<void> {
    for (const child of this.children.values()) {
      if (!this.poller.closed && !child.closed) await this.readChild(child);
    }
  }

  private async readChild(child: ChildState): Promise<void> {
    const consume = (name: string, args: unknown, output: string): boolean => {
      const byKey = this.wireTools.get(child.childId);
      const key = transcriptCallKey(name, args);
      const queue = byKey?.get(key);
      const entry = queue?.shift();
      if (!entry) return false;
      if (!queue!.length) byKey!.delete(key);
      if (output) this.amendWireOutput(entry, child.parentItemId, output);
      return true;
    };
    await child.tailer.readNext(row => {
      if (this.poller.closed) return;
      for (const event of mapChildTranscriptRow(row, child.childId, child.parentItemId, child.planned, child.seenSteps, consume)) {
        this.emit(event);
      }
    });
  }

  private amendWireOutput(entry: WireToolEntry, parentItemId: string | undefined, output: string): void {
    entry.transcriptOutput = output;
    if (!entry.item || entry.item.output || entry.amended || this.poller.closed) return;
    entry.amended = true;
    const item: UiToolItem = { ...entry.item, ...(parentItemId ? { parentItemId } : {}), output };
    this.emit({ type: 'item.updated', item, late: true });
  }
}
