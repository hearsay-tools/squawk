import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { UiToolItem } from '../../core/ui-events.ts';
import { ANTIGRAVITY_APP_DATA_DIR } from './launch-args.ts';

/**
 * The CLI 1.5.14 ACP wire sends no result for a read, an MCP call or a subagent tool: the completed
 * update has no `content`, `rawOutput` or `_meta` (hearsay-tools/squawk#4099). The CLI's own
 * transcript keeps what the agent received. It is a private format: every read is bounded, and a
 * missing file or a changed format leaves the tool with no output (docs/runners/antigravity-wire.md).
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

const rowSchema = z.object({
  step_index: z.number().int().nonnegative(), type: z.string(), status: z.string().optional(),
  content: z.string().optional(), error: z.string().optional(),
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

/** The text the agent received, without the CLI's `Created At:`/`Completed At:` lines, bounded. */
export function transcriptResultText(row: z.infer<typeof rowSchema>): string {
  const lines = (row.content ?? '').split('\n');
  let first = 0;
  while (first < lines.length && HEADER.test(lines[first]!)) first++;
  const text = lines.slice(first).join('\n') || (row.error ?? '');
  return text.length > TRANSCRIPT_OUTPUT_CHARS ? `${text.slice(0, TRANSCRIPT_OUTPUT_CHARS)}\n… (output truncated by Squawk)` : text;
}

export interface TranscriptCall { id: string; name: string; args: unknown }

/**
 * Matches tool calls to their result rows. A planner row lists the step's calls with the same
 * `name` and `args` the wire sends, and the k-th call's result is the row `step_index + 1 + k`.
 */
export class AntigravityTranscript {
  private readonly planned: Array<{ name: string; args: string; step: number; claimed: boolean }> = [];
  private readonly results = new Map<number, string>();
  private readonly claims = new Map<string, number>();

  addRow(value: unknown): void {
    const row = rowSchema.safeParse(value);
    if (!row.success) return;
    const { step_index: step, type, tool_calls: calls } = row.data;
    if (type === 'PLANNER_RESPONSE') {
      calls?.forEach((call, index) => this.planned.push({ name: call.name, args: canonical(call.args ?? {}), step: step + 1 + index, claimed: false }));
    } else if (!NOT_RESULTS.has(type)) this.results.set(step, transcriptResultText(row.data));
  }

  /** The call's result text once its row is known. The call claims the first planned call with its
   *  name and arguments, so repeated equal calls take their rows in order. */
  output(call: TranscriptCall): string | undefined {
    let step = this.claims.get(call.id);
    if (step === undefined) {
      const args = canonical(call.args ?? {});
      const planned = this.planned.find(entry => !entry.claimed && entry.name === call.name && entry.args === args);
      if (!planned) return undefined;
      planned.claimed = true;
      step = planned.step;
      this.claims.set(call.id, step);
    }
    return this.results.get(step);
  }
}

const updateSchema = z.object({
  sessionUpdate: z.enum(['tool_call', 'tool_call_update']), toolCallId: z.string(), name: z.string(),
  status: z.enum(['completed', 'failed']), args: z.unknown().optional(), rawInput: z.unknown().optional(),
});

/** A terminal tool update that carries no result: its output can come only from the transcript. */
export function transcriptCall(update: Record<string, unknown>): TranscriptCall | undefined {
  if (update.content != null || update.rawOutput != null) return undefined;
  const parsed = updateSchema.safeParse(update);
  if (!parsed.success) return undefined;
  return { id: parsed.data.toolCallId, name: parsed.data.name, args: parsed.data.args ?? parsed.data.rawInput };
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
  constructor(private readonly amend: (item: UiToolItem) => void, private readonly now: () => number = Date.now) {}

  /** The session is open: read its transcript from its current end. */
  open(path: string): void {
    this.path = path;
    try { this.offset = statSync(path).size; } catch { this.offset = 0; }
  }

  /** A wire update; a terminal tool update with no result starts the wait for its row. */
  observe(update: Record<string, unknown>): void {
    if (this.closed || this.broken || !this.path) return;
    const call = transcriptCall(update);
    if (call && !this.pending.has(call.id)) this.pending.set(call.id, { call, deadline: this.now() + TRANSCRIPT_WAIT_MS });
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

  private schedule(delay: number): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.poll().then(() => this.next()); }, delay);
    this.timer.unref?.();
  }

  private next(): void {
    this.expire();
    if ([...this.pending.values()].some(pending => pending.item)) this.schedule(POLL_MS);
  }

  private expire(): void {
    const now = this.now();
    for (const [id, pending] of this.pending) if (pending.deadline < now) this.pending.delete(id);
  }

  private async read(): Promise<void> {
    if (this.closed || this.broken || !this.path) return;
    this.expire();
    await this.readAppended(this.path);
    for (const [id, pending] of this.pending) {
      if (!pending.item) continue;
      const output = this.transcript.output(pending.call);
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
