import { describe, expect, it } from 'vitest';
import registerPiRunawayReplyGuard from './extensions/pi-runaway-reply-guard.mjs';

type Step =
  | { on: 'message_start' | 'message_end'; message: Record<string, unknown> }
  | { on: 'message_update'; delta: string; deltaType?: string };
type Handler = (event: unknown, ctx?: { abort(): void }) => { message?: Record<string, unknown> } | undefined;

/** Runs a fresh guard against a sequence of pi events; reports each abort and each rewritten message_end. */
function drive(steps: Step[]): Array<{ abortAt: number } | { rewritten: Record<string, unknown> | null }> {
  const handlers: Record<string, Handler> = {};
  registerPiRunawayReplyGuard({ on: (type, callback) => { handlers[type] = callback as unknown as Handler; } });
  const out: Array<{ abortAt: number } | { rewritten: Record<string, unknown> | null }> = [];
  steps.forEach((step, index) => {
    if (step.on === 'message_update') {
      const event = { assistantMessageEvent: { type: step.deltaType ?? 'text_delta', delta: step.delta } };
      handlers.message_update!(event, { abort: () => out.push({ abortAt: index }) });
    } else if (step.on === 'message_end') {
      out.push({ rewritten: handlers.message_end!({ message: step.message })?.message ?? null });
    } else {
      handlers.message_start!({ message: step.message });
    }
  });
  return out;
}

const KIB = 1024;
const assistant = { role: 'assistant', stopReason: 'aborted', content: [] };
const start: Step = { on: 'message_start', message: { role: 'assistant' } };
const text = (bytes: number): Step => ({ on: 'message_update', delta: 'x'.repeat(bytes) });

describe('pi runaway-reply guard (hearsay-tools/squawk#4236)', () => {
  it('lets a reply of exactly 64 KiB of text finish untouched', () => {
    expect(drive([start, text(32 * KIB), text(32 * KIB), { on: 'message_end', message: { ...assistant, stopReason: 'stop' } }]))
      .toEqual([{ rewritten: null }]);
  });

  it('stops a reply once when its text passes 64 KiB and reports it as a marked error', () => {
    expect(drive([start, text(64 * KIB), text(1), text(4 * KIB), { on: 'message_end', message: assistant }])).toEqual([
      { abortAt: 2 },
      { rewritten: { ...assistant, stopReason: 'error', errorMessage: '[cezar:runaway-reply] the reply passed 64 KiB of text in one message' } },
    ]);
  });

  it('counts UTF-8 bytes, so multi-byte text reaches the limit with fewer characters', () => {
    expect(drive([start, { on: 'message_update', delta: 'ż'.repeat(32 * KIB + 1) }])).toEqual([{ abortAt: 1 }]);
  });

  it('does not count thinking text', () => {
    expect(drive([start, { on: 'message_update', delta: 'x'.repeat(128 * KIB), deltaType: 'thinking_delta' }, { on: 'message_end', message: { ...assistant, stopReason: 'stop' } }]))
      .toEqual([{ rewritten: null }]);
  });

  it('counts each assistant message on its own', () => {
    expect(drive([
      start, text(40 * KIB), { on: 'message_end', message: { ...assistant, stopReason: 'toolUse' } },
      { on: 'message_start', message: { role: 'user' } },
      start, text(40 * KIB), { on: 'message_end', message: { ...assistant, stopReason: 'stop' } },
    ])).toEqual([{ rewritten: null }, { rewritten: null }]);
  });

  it('leaves the message after a stopped one untouched', () => {
    expect(drive([
      start, text(65 * KIB), { on: 'message_end', message: assistant },
      start, text(1), { on: 'message_end', message: { ...assistant, stopReason: 'stop' } },
    ])).toEqual([
      { abortAt: 1 },
      { rewritten: expect.objectContaining({ stopReason: 'error' }) },
      { rewritten: null },
    ]);
  });
});
