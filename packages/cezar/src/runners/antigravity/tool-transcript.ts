import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { hookEventName, isVisibleHookItem } from '../../core/hook-items.ts';
import type { HookStatus, UiHookItem, UiToolItem } from '../../core/ui-events.ts';
import { ANTIGRAVITY_APP_DATA_DIR } from './launch-args.ts';

/**
 * The CLI 1.5.14 ACP wire sends no result for a read, an MCP call or a subagent tool (the completed
 * update has no `content`, `rawOutput` or `_meta`, hearsay-tools/squawk#4099) and carries no hook
 * lifecycle frame. The CLI's own transcript keeps both tool results and injected hook messages
 * (`SYSTEM_MESSAGE` rows with `source: "SYSTEM_SDK"`). It is a private format: every read is
 * bounded, and a missing file or a changed format leaves no output (docs/runners/antigravity-wire.md).
 */
export const TRANSCRIPT_OUTPUT_CHARS = 64 * 1024;
const READ_BYTES = 4 * 1024 * 1024;
const LINE_BYTES = 8 * 1024 * 1024;
const POLL_MS = 250;
/** How long after a tool completes the runner looks for its row. */
export const TRANSCRIPT_WAIT_MS = 10_000;
/** Rows that never hold a tool's result. */
const NOT_RESULTS: ReadonlySet<string> = new Set(['PLANNER_RESPONSE', 'USER_INPUT', 'SYSTEM_MESSAGE', 'CHECKPOINT']);
const HEADER = /^(?:Created|Completed) At: .*$/;
const SYSTEM_BLOCK = /(?:^|\n)<SYSTEM_MESSAGE>\r?\n([\s\S]*)\r?\n<\/SYSTEM_MESSAGE>\s*$/;
const HOOK_HEADER = /^The following system message was injected by an? ([A-Za-z][A-Za-z0-9_-]*) hook:\r?\n?([\s\S]*)$/;

const rowSchema = z.object({
  step_index: z.number().int().nonnegative(), type: z.string(), source: z.string().optional(),
  status: z.string().optional(), content: z.string().optional(), error: z.string().optional(),
  tool_calls: z.array(z.object({ name: z.string(), args: z.unknown().optional() })).optional(),
});

export function antigravityTranscriptPath(geminiDir: string, sessionId: string): string {
  return join(geminiDir, ANTIGRAVITY_APP_DATA_DIR, 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

/** A JSON value with object keys sorted, so two equal argument objects compare equal as text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function boundOutput(text: string): string {
  return text.length > TRANSCRIPT_OUTPUT_CHARS ? `${text.slice(0, TRANSCRIPT_OUTPUT_CHARS)}\n… (output truncated by Squawk)` : text;
}

/** The text the agent received, without the CLI's `Created At:`/`Completed At:` lines, bounded. */
export function transcriptResultText(row: z.infer<typeof rowSchema>): string {
  const lines = (row.content ?? '').split('\n');
  let first = 0;
  while (first < lines.length && HEADER.test(lines[first]!)) first++;
  const text = lines.slice(first).join('\n') || (row.error ?? '');
  return boundOutput(text);
}

/** A `SYSTEM_SDK` `SYSTEM_MESSAGE` row injected by a native Antigravity hook, mapped to a hook item. */
export function transcriptHookItem(row: z.infer<typeof rowSchema>): UiHookItem | undefined {
  if (row.type !== 'SYSTEM_MESSAGE' || row.source !== 'SYSTEM_SDK') return undefined;
  const content = row.content ?? '';
  const body = (SYSTEM_BLOCK.exec(content)?.[1] ?? content).trim();
  const header = HOOK_HEADER.exec(body);
  if (!header) return undefined;
  const status: HookStatus = row.status === 'ERROR' ? 'failed' : 'completed';
  const text = header[2]!.trim();
  const entries: UiHookItem['entries'] = text
    ? [{ kind: status === 'failed' ? 'error' : 'context', text: boundOutput(text) }]
    : row.error?.trim() ? [{ kind: 'error', text: boundOutput(row.error.trim()) }] : [];
  const item: UiHookItem = { kind: 'hook', id: `hook_step_${row.step_index}`, event: hookEventName(header[1]!), status, entries };
  return isVisibleHookItem(item) ? item : undefined;
}

export interface TranscriptCall { id: string; name: string; args: unknown }

/** Result texts held at once; the oldest goes first. */
const HELD_RESULTS = 64;

/**
 * Matches tool calls to their result rows, and extracts injected hook `SYSTEM_MESSAGE` rows.
 * A planner row lists the step's calls with the same `name` and `args` the wire sends, and the k-th
 * call's result is the row `step_index + 1 + k`. Each call takes its slot when it starts, so the
 * n-th started call with a name and arguments gets the n-th planned one: neither the order calls
 * complete in nor a call that stopped waiting moves another call's result. Only results a waiting
 * call can still take are held.
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

  /** A call started on the wire: it takes the next planned slot of its name and arguments. */
  start(call: TranscriptCall): void {
    const key = callKey(call.name, call.args);
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
    const row = rowSchema.safeParse(value);
    if (!row.success) return;
    const { step_index: step, type, tool_calls: calls } = row.data;
    if (type === 'PLANNER_RESPONSE') {
      calls?.forEach((call, index) => {
        const key = callKey(call.name, call.args);
        this.planned.set(key, [...this.planned.get(key) ?? [], step + 1 + index]);
        this.pair(key);
      });
    } else if (type === 'SYSTEM_MESSAGE') {
      const hook = transcriptHookItem(row.data);
      if (hook && !this.seenHooks.has(step)) { this.seenHooks.add(step); this.hooks.push(hook); }
    } else if (!NOT_RESULTS.has(type) && this.wanted(step)) this.hold(step, transcriptResultText(row.data));
  }

  /** Injected hook items read since the last drain. */
  drainHooks(): UiHookItem[] {
    return this.hooks.splice(0);
  }

  /** The call's result text once its row is read; reading it consumes it. */
  output(id: string): string | undefined {
    const step = this.steps.get(id);
    const text = step === undefined ? undefined : this.results.get(step);
    if (text === undefined) return undefined;
    this.steps.delete(id);
    this.results.delete(step!);
    return text;
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

function callKey(name: string, args: unknown): string { return `${name}\u0000${canonical(args ?? {})}`; }

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

interface Pending { call: TranscriptCall; item?: UiToolItem; deadline: number }

/**
 * Reads the session's transcript while a completed tool waits for its output, and amends the tool
 * card when the row appears. The row can land after the wire's completed update, so the read polls
 * up to `TRANSCRIPT_WAIT_MS`. It reads only bytes appended since the session opened.
 */
export class AntigravityToolOutputs {
  private path: string | undefined;
  private offset = 0;
  private tail = '';
  private readonly decoder = new StringDecoder('utf8');
  private skippingLine = false;
  private broken = false;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;
  private reading: Promise<void> | undefined;
  private readonly transcript = new AntigravityTranscript();
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  constructor(
    private readonly amend: (item: UiToolItem) => void,
    private readonly now: () => number = Date.now,
    private readonly onHook?: (item: UiHookItem) => void,
  ) {}

  /** The session is open: read its transcript from its current end. */
  open(path: string): void {
    this.path = path;
    try { this.offset = statSync(path).size; } catch { this.offset = 0; }
    if (this.onHook) this.schedule(POLL_MS);
  }

  /** A wire update. A call takes its transcript slot when it first appears; a terminal update with
   *  no result starts the wait for its row, and one with a result gives the slot up. */
  observe(update: Record<string, unknown>): void {
    if (this.closed || this.broken || !this.path) return;
    const call = wireCall(update);
    if (!call) return;
    if (!this.seen.has(call.id)) { this.seen.add(call.id); this.transcript.start(call); }
    if (!TERMINAL.has(update.status)) return;
    if (transcriptCall(update)) { if (!this.pending.has(call.id)) this.pending.set(call.id, { call, deadline: this.now() + TRANSCRIPT_WAIT_MS }); }
    else this.transcript.drop(call.id);
  }

  /** The mapped tool item closed with no output: amend it once its row is read. */
  completed(item: UiToolItem): void {
    const pending = this.pending.get(item.id);
    if (!pending) return;
    if (item.output) { this.pending.delete(item.id); return; }
    pending.item = item;
    this.schedule(0);
  }

  close(): void { this.closed = true; clearTimeout(this.timer); this.pending.clear(); }

  /** One read of appended rows, then amend what resolved. Tests call it directly. */
  poll(): Promise<void> {
    this.reading ??= this.read().catch(() => { this.broken = true; this.pending.clear(); }).finally(() => { this.reading = undefined; });
    return this.reading;
  }

  /** Wait for any in-flight read, then perform one fresh read for rows appended before exit. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.reading) await this.reading;
    await this.poll();
  }

  private schedule(delay: number): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll().then(() => this.next()); }, delay);
    this.timer.unref?.();
  }

  private next(): void {
    this.expire();
    if (this.onHook || [...this.pending.values()].some(pending => pending.item)) this.schedule(POLL_MS);
  }

  private expire(): void {
    const now = this.now();
    for (const [id, pending] of this.pending) if (pending.deadline < now) { this.pending.delete(id); this.transcript.drop(id); }
  }

  private async read(): Promise<void> {
    if (this.closed || this.broken || !this.path) return;
    this.expire();
    await this.readAppended(this.path);
    for (const hook of this.transcript.drainHooks()) if (!this.closed) this.onHook?.(hook);
    for (const [id, pending] of this.pending) {
      if (!pending.item) continue;
      const output = this.transcript.output(id);
      if (output === undefined) continue;
      this.pending.delete(id);
      if (output && !this.closed) this.amend({ ...pending.item, output });
    }
  }

  private async readAppended(path: string): Promise<void> {
    let file;
    try { file = await open(path, 'r'); } catch { return; }
    try {
      const { size } = await file.stat();
      if (size <= this.offset) return;
      const length = Math.min(size - this.offset, READ_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      this.lines(this.decoder.write(buffer.subarray(0, bytesRead)));
    } finally { await file.close(); }
  }

  private lines(chunk: string): void {
    const lines = (this.tail + chunk).split('\n');
    this.tail = lines.pop() ?? '';
    for (const line of lines) {
      if (this.skippingLine) { this.skippingLine = false; continue; }
      if (!line.trim()) continue;
      try { this.transcript.addRow(JSON.parse(line)); } catch { /* A row the format no longer matches has no output. */ }
    }
    // A row past the bound is dropped; reading resumes at the next line.
    if (this.tail.length > LINE_BYTES) { this.tail = ''; this.skippingLine = true; }
  }
}
