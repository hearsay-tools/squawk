import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { hookEventName, isVisibleHookItem } from '@hearsay-tools/squawk/plugin/runtime';
import { z, type HookStatus, type UiHookItem } from '@hearsay-tools/squawk/plugin';
import { ANTIGRAVITY_APP_DATA_DIR } from './launch-args.ts';

export const TRANSCRIPT_OUTPUT_CHARS = 64 * 1024;
export const TRANSCRIPT_READ_BYTES = 4 * 1024 * 1024;
export const TRANSCRIPT_MAX_FLUSH_CHUNKS = 8;
const LINE_BYTES = 8 * 1024 * 1024;
export const NOT_RESULT_ROW_TYPES: ReadonlySet<string> = new Set(['PLANNER_RESPONSE', 'USER_INPUT', 'SYSTEM_MESSAGE', 'CHECKPOINT']);
const HEADER = /^(?:Created|Completed) At: .*$/;
const SYSTEM_BLOCK = /(?:^|\n)<SYSTEM_MESSAGE>\r?\n([\s\S]*)\r?\n<\/SYSTEM_MESSAGE>\s*$/;
const HOOK_HEADER = /^The following system message was injected by an? ([A-Za-z][A-Za-z0-9_-]*) hook:\r?\n?([\s\S]*)$/;

export const transcriptRowSchema = z.object({
  step_index: z.number().int().nonnegative(), type: z.string(), source: z.string().optional(),
  status: z.string().optional(), content: z.string().optional(), error: z.string().optional(),
  thinking: z.string().optional(),
  tool_calls: z.array(z.object({ name: z.string(), args: z.unknown().optional() })).optional(),
});
export type TranscriptRow = z.infer<typeof transcriptRowSchema>;

export function antigravityTranscriptPath(geminiDir: string, sessionId: string): string {
  return join(geminiDir, ANTIGRAVITY_APP_DATA_DIR, 'brain', sessionId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

/** A JSON value with object keys sorted, so two equal argument objects compare equal as text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function transcriptCallKey(name: string, args: unknown): string {
  return `${name}\u0000${canonicalJson(args ?? {})}`;
}

export function boundTranscriptOutput(text: string): string {
  return text.length > TRANSCRIPT_OUTPUT_CHARS ? `${text.slice(0, TRANSCRIPT_OUTPUT_CHARS)}\n… (output truncated by Squawk)` : text;
}

/** The text the agent received, without the CLI's `Created At:`/`Completed At:` lines, bounded. */
export function transcriptResultText(row: TranscriptRow): string {
  const lines = (row.content ?? '').split('\n');
  let first = 0;
  while (first < lines.length && HEADER.test(lines[first]!)) first++;
  const text = lines.slice(first).join('\n') || (row.error ?? '');
  return boundTranscriptOutput(text);
}

/** A `SYSTEM_SDK` `SYSTEM_MESSAGE` row injected by a native Antigravity hook, mapped to a hook item. */
export function transcriptHookItem(row: TranscriptRow, idPrefix = ''): UiHookItem | undefined {
  if (row.type !== 'SYSTEM_MESSAGE' || row.source !== 'SYSTEM_SDK') return undefined;
  const content = row.content ?? '';
  const body = (SYSTEM_BLOCK.exec(content)?.[1] ?? content).trim();
  const header = HOOK_HEADER.exec(body);
  if (!header) return undefined;
  const status: HookStatus = row.status === 'ERROR' ? 'failed' : 'completed';
  const text = header[2]!.trim();
  const entries: UiHookItem['entries'] = text
    ? [{ kind: status === 'failed' ? 'error' : 'context', text: boundTranscriptOutput(text) }]
    : row.error?.trim() ? [{ kind: 'error', text: boundTranscriptOutput(row.error.trim()) }] : [];
  const item: UiHookItem = { kind: 'hook', id: `${idPrefix}hook_step_${row.step_index}`, event: hookEventName(header[1]!), status, entries };
  return isVisibleHookItem(item) ? item : undefined;
}

/** Bounded append-only JSONL file tailer shared by parent and child Antigravity transcripts. */
export class BoundedJsonlTailer {
  private offset = 0;
  private tail = '';
  private readonly decoder = new StringDecoder('utf8');
  private skippingLine = false;
  hasMore = false;

  constructor(private readonly path: string, fromEnd: boolean, private readonly readBytes = TRANSCRIPT_READ_BYTES) {
    if (fromEnd) {
      try { this.offset = statSync(path).size; } catch { this.offset = 0; }
    }
  }

  async readNext(onRow: (value: unknown) => void): Promise<void> {
    let file;
    try { file = await open(this.path, 'r'); } catch { this.hasMore = false; return; }
    try {
      const { size } = await file.stat();
      if (size <= this.offset) { this.hasMore = false; return; }
      const length = Math.min(size - this.offset, this.readBytes);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, this.offset);
      this.offset += bytesRead;
      this.hasMore = bytesRead > 0 && this.offset < size;
      this.feed(this.decoder.write(buffer.subarray(0, bytesRead)), onRow);
    } finally { await file.close(); }
  }

  private feed(chunk: string, onRow: (value: unknown) => void): void {
    const lines = (this.tail + chunk).split('\n');
    this.tail = lines.pop() ?? '';
    for (const line of lines) {
      if (this.skippingLine) { this.skippingLine = false; continue; }
      if (!line.trim()) continue;
      try { onRow(JSON.parse(line)); } catch { /* A row the format no longer matches is skipped. */ }
    }
    if (this.tail.length > LINE_BYTES) { this.tail = ''; this.skippingLine = true; }
  }
}

/** Serialized timer-driven poller shared by parent and child Antigravity transcript readers. */
export class TranscriptPoller {
  private timer: NodeJS.Timeout | undefined;
  private reading: Promise<void> | undefined;
  closed = false;

  constructor(
    private readonly step: () => Promise<void>,
    private readonly shouldContinue: () => boolean,
    private readonly pollMs: number,
    private readonly onError?: () => void,
  ) {}

  schedule(delay: number): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll().then(() => { if (!this.closed && this.shouldContinue()) this.schedule(this.pollMs); });
    }, delay);
    this.timer.unref?.();
  }

  poll(): Promise<void> {
    this.reading ??= this.step().catch(() => { this.onError?.(); }).finally(() => { this.reading = undefined; });
    return this.reading;
  }

  async waitIdle(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    while (this.reading) await this.reading;
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
