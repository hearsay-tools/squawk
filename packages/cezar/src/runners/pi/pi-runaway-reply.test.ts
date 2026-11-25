import { sealTestRunners } from '../../core/runner-registry.testkit.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../core/agent-runner.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import { UNSET_TOOL_GRANT } from '../../core/tool-grant.testkit.ts';
import { piRunner } from './definition.ts';
import { PiRunner } from './pi-runner.ts';
import { RUNAWAY_REPLY_RETRY_PROMPT } from './runaway-reply.ts';

// The runner builds its child env through the registry.
sealTestRunners(piRunner);

type Reply = 'runaway' | 'clean';

/** A pi RPC mock that answers prompt n with replies[n] and logs every prompt it reads to prompts.ndjson. */
function writeMock(cwd: string, replies: Reply[]): string {
  const mockPath = join(cwd, 'mock-pi-runaway.mjs');
  writeFileSync(mockPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const replies = ${JSON.stringify(replies)};
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
let prompts = 0;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-runaway', model: { id: 'grok-4.7' } } });
  } else if (command.type === 'prompt') {
    appendFileSync(${JSON.stringify(join(cwd, 'prompts.ndjson'))}, JSON.stringify({ id: command.id ?? null, message: command.message }) + '\\n');
    send({ ...(command.id ? { id: command.id } : {}), type: 'response', command: 'prompt', success: true });
    send({ type: 'agent_start' });
    send({ type: 'turn_start' });
    send({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: command.message }] } });
    if (replies[prompts++] === 'runaway') {
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'I am reading the cases next.\\n' } });
      send({ type: 'message_end', message: { role: 'assistant', provider: 'cliproxy-grok', model: 'grok-4.7', usage,
        content: [{ type: 'text', text: 'I am reading the cases next.\\n' }],
        stopReason: 'error', errorMessage: '[cezar:runaway-reply] the reply passed 64 KiB of text in one message' } });
    } else {
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'finished' } });
      send({ type: 'message_end', message: { role: 'assistant', provider: 'cliproxy-grok', model: 'grok-4.7', usage,
        content: [{ type: 'text', text: 'finished' }], stopReason: 'stop' } });
    }
    send({ type: 'turn_end', message: {}, toolResults: [] });
    send({ type: 'agent_end', messages: [], willRetry: false });
    send({ type: 'agent_settled' });
  } else if (command.type === 'abort') {
    send({ type: 'response', command: 'abort', success: true });
  }
}
`, { mode: 0o755 });
  return mockPath;
}

/**
 * A pi RPC mock for input that lands between the runaway run's end and its agent_settled: pi starts
 * the input's run first, so it is processing when the retry prompt arrives, and it rejects any
 * prompt without streamingBehavior there, as pi does.
 */
function writeRaceMock(cwd: string): string {
  const mockPath = join(cwd, 'mock-pi-runaway-race.mjs');
  writeFileSync(mockPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const send = (v) => process.stdout.write(JSON.stringify(v) + '\\n');
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
const end = (stopReason, extra = {}) => {
  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' } });
  send({ type: 'message_end', message: { role: 'assistant', provider: 'cliproxy-grok', model: 'grok-4.7', usage, content: [{ type: 'text', text: 'x' }], stopReason, ...extra } });
};
let prompts = 0;
let busy = false;
for await (const line of readline.createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.type === 'get_state') {
    send({ id: command.id, type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-race', model: { id: 'grok-4.7' } } });
    continue;
  }
  if (command.type !== 'prompt') continue;
  appendFileSync(${JSON.stringify(join(cwd, 'prompts.ndjson'))}, JSON.stringify({ id: command.id ?? null, message: command.message, streamingBehavior: command.streamingBehavior ?? null }) + '\\n');
  const ack = { ...(command.id ? { id: command.id } : {}), type: 'response', command: 'prompt' };
  if (busy && !command.streamingBehavior) { send({ ...ack, success: false, error: 'Agent is already processing. Specify streamingBehavior' }); continue; }
  send({ ...ack, success: true });
  prompts += 1;
  if (prompts === 1) {
    send({ type: 'agent_start' });
    end('error', { errorMessage: '[cezar:runaway-reply] the reply passed 64 KiB of text in one message' });
    send({ type: 'agent_end', messages: [], willRetry: false });
  } else if (prompts === 2) {
    // The input reached pi before Squawk read agent_settled: its run is already processing.
    send({ type: 'agent_settled' });
    busy = true;
    send({ type: 'agent_start' });
  } else {
    // The steered retry joins the running run, which then ends cleanly.
    end('stop');
    send({ type: 'agent_end', messages: [], willRetry: false });
    busy = false;
    send({ type: 'agent_settled' });
  }
}
`, { mode: 0o755 });
  return mockPath;
}

interface Run { events: AgentEvent[]; uiEvents: UiEvent[]; prompts: Array<{ id: string | null; message: string }> }

/** Runs one session: the opening prompt, then each follow-up after the previous turn ends. */
async function run(cwd: string, replies: Reply[], followUps: string[] = []): Promise<Run> {
  const events: AgentEvent[] = [];
  const uiEvents: UiEvent[] = [];
  const pending = [...followUps];
  const session = new PiRunner({ bin: writeMock(cwd, replies) }).startSession(
    { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'go', cwd, timeoutMs: 10_000 },
    (event) => {
      events.push(event);
      if (event.type !== 'turn-end') return;
      const next = pending.shift();
      if (next === undefined) session.end();
      else session.sendMessage([{ type: 'text', text: next }]);
    },
    { onUiEvent: (event) => uiEvents.push(event) },
  );
  await session.result;
  const prompts = readFileSync(join(cwd, 'prompts.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  return { events, uiEvents, prompts };
}

const NOTE = 'pi: stopped a runaway reply (over 64 KiB of text in one message) and asked the model to continue (retry 1 of 1)';
const FAILURE = 'pi: cliproxy-grok/grok-4.7 request failed: Squawk stopped a runaway reply twice (over 64 KiB of text in one message)';

describe('pi runaway-reply retry (hearsay-tools/squawk#4236)', () => {
  const saved = process.env.CEZ_DRY_RUN;
  let cwd: string;

  beforeEach(() => {
    process.env.CEZ_DRY_RUN = '1';
    cwd = mkdtempSync(join(tmpdir(), 'cez-pi-runaway-'));
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = saved;
    rmSync(cwd, { recursive: true, force: true });
  });

  it('retries a runaway reply once in the same session and keeps the turn open until the retry settles', async () => {
    const { events, uiEvents, prompts } = await run(cwd, ['runaway', 'clean']);
    expect(prompts.map((prompt) => prompt.message)).toEqual(['go', RUNAWAY_REPLY_RETRY_PROMPT]);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.filter((event) => event.type === 'note').map((event) => event.message)).toContain(NOTE);
    expect(events.filter((event) => event.type === 'turn-end')).toHaveLength(1);
    expect(uiEvents.filter((event) => event.type === 'turn.completed')).toHaveLength(1);
    expect(uiEvents.filter((event) => event.type === 'session.error')).toEqual([]);
  });

  it('fails the turn when the retry runs away too', async () => {
    const { events, prompts } = await run(cwd, ['runaway', 'runaway']);
    expect(prompts.map((prompt) => prompt.message)).toEqual(['go', RUNAWAY_REPLY_RETRY_PROMPT]);
    expect(events.filter((event) => event.type === 'error').map((event) => event.message)).toEqual([FAILURE]);
    expect(events.filter((event) => event.type === 'turn-end')).toHaveLength(1);
  });

  it('gives a later turn its own retry', async () => {
    const { events, prompts } = await run(cwd, ['runaway', 'clean', 'runaway', 'clean'], ['next']);
    expect(prompts.map((prompt) => prompt.message)).toEqual(['go', RUNAWAY_REPLY_RETRY_PROMPT, 'next', RUNAWAY_REPLY_RETRY_PROMPT]);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.filter((event) => event.type === 'turn-end')).toHaveLength(2);
  });

  it('steers the retry into a run that input started before Squawk read agent_settled', async () => {
    const events: AgentEvent[] = [];
    let steered = false;
    const session = new PiRunner({ bin: writeRaceMock(cwd) }).startSession(
      { toolGrant: UNSET_TOOL_GRANT, userPrompt: 'go', cwd, timeoutMs: 10_000 },
      (event) => {
        events.push(event);
        if (event.type === 'text' && !steered) { steered = true; session.sendMessage([{ type: 'text', text: 'more' }]); }
        if (event.type === 'turn-end') session.end();
      },
    );
    await session.result;
    const prompts = readFileSync(join(cwd, 'prompts.ndjson'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(prompts.map((prompt) => [prompt.message, prompt.streamingBehavior])).toEqual([
      ['go', null], ['more', 'steer'], [RUNAWAY_REPLY_RETRY_PROMPT, 'steer'],
    ]);
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.filter((event) => event.type === 'turn-end')).toHaveLength(1);
  });
});
