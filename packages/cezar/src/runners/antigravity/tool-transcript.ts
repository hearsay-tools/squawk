import { z, type UiHookItem, type UiToolItem } from '@hearsay-tools/squawk/plugin';
import { parseChildMessageDelivery, parseSpawnedSubagentId } from './subagent-tracker.ts';
import {
  BoundedJsonlTailer,
  NOT_RESULT_ROW_TYPES,
  TRANSCRIPT_MAX_FLUSH_CHUNKS,
  TRANSCRIPT_OUTPUT_CHARS,
  TRANSCRIPT_READ_BYTES,
  TranscriptPoller,
  antigravityTranscriptPath,
  transcriptCallKey,
  transcriptHookItem,
  transcriptResultText,
  transcriptRowSchema,
} from './transcript-tailer.ts';

export { TRANSCRIPT_OUTPUT_CHARS, antigravityTranscriptPath, transcriptHookItem, transcriptResultText };

/**
 * The CLI 1.5.14–1.5.18 ACP wire sends no result for a read, an MCP call or a subagent tool (the
 * completed update has no `content`, `rawOutput` or `_meta`, hearsay-tools/squawk#4099) and carries
 * no hook lifecycle frame. The CLI's own transcript keeps tool results, spawned subagent IDs, child
 * message deliveries, and injected hook messages (`SYSTEM_MESSAGE` rows with `source: "SYSTEM_SDK"`).
 * It is a private format: every read is bounded, and a missing file or a changed format leaves no
 * output (docs/runners/antigravity-wire.md).
 */
const POLL_MS = 250;
/** How long after a tool completes the runner looks for its row. */
export const TRANSCRIPT_WAIT_MS = 10_000;

export interface TranscriptCall { id: string; name: string; args: unknown }
export interface SubagentTranscriptHooks {
  onSpawn?(parentItemId: string, childId: string): void;
  onMessage?(childId: string, body: string): void;
}

/** Result texts held at once; the oldest goes first. */
const HELD_RESULTS = 64;

/**
 * Matches tool calls to their result rows, extracts injected hook `SYSTEM_MESSAGE` rows, and
 * surfaces delivered child subagent messages (`sender=<childId>`).
 */
export class AntigravityTranscript {
  /** Per call key: planned result steps, and started calls, that have no partner yet. */
  private readonly planned = new Map<string, number[]>();
  private readonly started = new Map<string, string[]>();
  private readonly steps = new Map<string, number>();
  private readonly dropped = new Set<string>();
  private readonly results = new Map<number, string>();
  private readonly hooks: UiHookItem[] = [];
  private readonly seenHooks = new Set<number>();
  private readonly childMessages: Array<{ childId: string; body: string }> = [];
  private readonly seenMessages = new Set<number>();

  /** A call started on the wire: it takes the next planned slot of its name and arguments. */
  start(call: TranscriptCall): void {
    const key = transcriptCallKey(call.name, call.args);
    this.started.set(key, [...this.started.get(key) ?? [], call.id]);
    this.pair(key);
  }

  /** The call no longer waits (it had wire output, or its wait ended): it keeps its slot and its
   *  result is thrown away. */
  drop(id: string): void {
    const step = this.steps.get(id);
    if (step === undefined) { this.dropped.add(id); return; }
    this.steps.delete(id);
    this.results.delete(step);
  }

  addRow(value: unknown): void {
    const row = transcriptRowSchema.safeParse(value);
    if (!row.success) return;
    const { step_index: step, type, tool_calls: calls } = row.data;
    if (type === 'PLANNER_RESPONSE') {
      calls?.forEach((call, index) => {
        const key = transcriptCallKey(call.name, call.args);
        this.planned.set(key, [...this.planned.get(key) ?? [], step + 1 + index]);
        this.pair(key);
      });
    } else if (type === 'SYSTEM_MESSAGE') {
      this.addSystemRow(row.data);
    } else if (!NOT_RESULT_ROW_TYPES.has(type) && this.wanted(step)) this.hold(step, transcriptResultText(row.data));
  }

  /** Injected hook items read since the last drain. */
  drainHooks(): UiHookItem[] { return this.hooks.splice(0); }

  /** Subagent reply notices read since the last drain. */
  drainChildMessages(): Array<{ childId: string; body: string }> { return this.childMessages.splice(0); }

  /** The call's result text once its row is read; reading it consumes it. */
  output(id: string): string | undefined {
    const step = this.steps.get(id);
    const text = step === undefined ? undefined : this.results.get(step);
    if (text === undefined) return undefined;
    this.steps.delete(id);
    this.results.delete(step!);
    return text;
  }

  private addSystemRow(row: z.infer<typeof transcriptRowSchema>): void {
    const hook = transcriptHookItem(row);
    if (hook && !this.seenHooks.has(row.step_index)) { this.seenHooks.add(row.step_index); this.hooks.push(hook); return; }
    if (row.source !== 'SYSTEM' || !row.content || this.seenMessages.has(row.step_index)) return;
    const delivery = parseChildMessageDelivery(row.content);
    if (delivery) { this.seenMessages.add(row.step_index); this.childMessages.push(delivery); }
  }

  private pair(key: string): void {
    const planned = this.planned.get(key) ?? [];
    const started = this.started.get(key) ?? [];
    while (planned.length && started.length) {
      const step = planned.shift()!;
      const id = started.shift()!;
      if (this.dropped.delete(id)) this.results.delete(step);
      else this.steps.set(id, step);
    }
    for (const [map, list] of [[this.planned, planned], [this.started, started]] as const) {
      if (list.length) (map as Map<string, unknown[]>).set(key, list); else map.delete(key);
    }
  }

  /** A row a call holds, or one a started call has yet to pair with. */
  private wanted(step: number): boolean {
    for (const held of this.steps.values()) if (held === step) return true;
    for (const steps of this.planned.values()) if (steps.includes(step)) return true;
    return false;
  }

  private hold(step: number, text: string): void {
    this.results.set(step, text);
    for (const old of this.results.keys()) { if (this.results.size <= HELD_RESULTS) break; this.results.delete(old); }
  }
}

const wireSchema = z.object({
  sessionUpdate: z.enum(['tool_call', 'tool_call_update']), toolCallId: z.string(), name: z.string(),
  args: z.unknown().optional(), rawInput: z.unknown().optional(),
});
const TERMINAL: ReadonlySet<unknown> = new Set(['completed', 'failed']);

function wireCall(update: Record<string, unknown>): TranscriptCall | undefined {
  const parsed = wireSchema.safeParse(update);
  if (!parsed.success) return undefined;
  return { id: parsed.data.toolCallId, name: parsed.data.name, args: parsed.data.args ?? parsed.data.rawInput };
}

/** A terminal tool update that carries no result: its output can come only from the transcript. */
export function transcriptCall(update: Record<string, unknown>): TranscriptCall | undefined {
  if (update.content != null || update.rawOutput != null || !TERMINAL.has(update.status)) return undefined;
  return wireCall(update);
}

interface Pending { call: TranscriptCall; item?: UiToolItem; spawn?: boolean; deadline: number }

/**
 * Reads the session's transcript while a completed tool waits for its output, resolves spawned
 * subagent conversation IDs, detects child message deliveries, and emits injected hook items.
 */
export class AntigravityToolOutputs {
  private tailer: BoundedJsonlTailer | undefined;
  private broken = false;
  private readonly transcript = new AntigravityTranscript();
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  private readonly poller: TranscriptPoller;
  constructor(
    private readonly amend: (item: UiToolItem) => void,
    private readonly now: () => number = Date.now,
    private readonly onHook?: (item: UiHookItem) => void,
    private readonly readBytes = TRANSCRIPT_READ_BYTES,
    private readonly subagents?: SubagentTranscriptHooks,
  ) {
    this.poller = new TranscriptPoller(
      () => this.read(),
      () => {
        this.expire();
        return Boolean(this.onHook || this.subagents || [...this.pending.values()].some(pending => pending.item || pending.spawn));
      },
      POLL_MS,
      () => { this.broken = true; this.pending.clear(); },
    );
  }

  /** The session is open: read its transcript from its current end. */
  open(path: string): void {
    this.tailer = new BoundedJsonlTailer(path, true, this.readBytes);
    if (this.onHook || this.subagents) this.poller.schedule(POLL_MS);
  }

  /** A wire update. A call takes its transcript slot when it first appears; a terminal update with
   *  no result starts the wait for its row, and one with a result gives the slot up. */
  observe(update: Record<string, unknown>): void {
    if (this.poller.closed || this.broken || !this.tailer) return;
    const call = wireCall(update);
    if (!call) return;
    if (!this.seen.has(call.id)) { this.seen.add(call.id); this.transcript.start(call); }
    if (!TERMINAL.has(update.status)) return;
    if (!transcriptCall(update)) { this.transcript.drop(call.id); return; }
    const spawn = call.name === 'invoke_subagent' && update.status === 'completed' && !!this.subagents?.onSpawn;
    if (!this.pending.has(call.id)) this.pending.set(call.id, { call, spawn, deadline: this.now() + TRANSCRIPT_WAIT_MS });
    if (spawn) this.poller.schedule(0);
  }

  /** The mapped tool item closed with no output: amend it once its row is read. */
  completed(item: UiToolItem): void {
    const pending = this.pending.get(item.id);
    if (!pending || pending.spawn) return;
    if (item.output) { this.pending.delete(item.id); return; }
    pending.item = item;
    this.poller.schedule(0);
  }

  close(): void { this.poller.close(); this.pending.clear(); }

  /** One read of appended rows, then amend what resolved. Tests call it directly. */
  poll(): Promise<void> { return this.poller.poll(); }

  /** Wait for any in-flight read, then drain unread exit bytes in bounded chunks. */
  async flush(): Promise<void> {
    await this.poller.waitIdle();
    for (let chunk = 0; chunk < TRANSCRIPT_MAX_FLUSH_CHUNKS && !this.poller.closed && !this.broken && this.tailer; chunk++) {
      await this.poll();
      if (!this.tailer.hasMore) break;
    }
  }

  private expire(): void {
    const now = this.now();
    for (const [id, pending] of this.pending) if (pending.deadline < now) { this.pending.delete(id); this.transcript.drop(id); }
  }

  private async read(): Promise<void> {
    if (this.poller.closed || this.broken || !this.tailer) return;
    this.expire();
    await this.tailer.readNext(row => this.transcript.addRow(row));
    for (const hook of this.transcript.drainHooks()) if (!this.poller.closed) this.onHook?.(hook);
    for (const [id, pending] of this.pending) this.resolvePending(id, pending);
    for (const delivery of this.transcript.drainChildMessages()) {
      if (!this.poller.closed) this.subagents?.onMessage?.(delivery.childId, delivery.body);
    }
  }

  private resolvePending(id: string, pending: Pending): void {
    if (!pending.item && !pending.spawn) return;
    const output = this.transcript.output(id);
    if (output === undefined) return;
    this.pending.delete(id);
    if (this.poller.closed) return;
    if (pending.spawn) {
      const childId = parseSpawnedSubagentId(output);
      if (childId) this.subagents?.onSpawn?.(id, childId);
    } else if (output && pending.item) {
      this.amend({ ...pending.item, output });
    }
  }
}
