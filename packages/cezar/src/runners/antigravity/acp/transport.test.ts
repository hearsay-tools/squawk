import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { AcpSession } from './session.ts';
import { AcpRpcError, AcpTransport } from './transport.ts';
import { AcpEvents } from './events.ts';
import type { AgentEvent } from '../../../core/agent-runner.ts';
import type { UiEvent } from '../../../core/ui-events.ts';

function wire(request: ConstructorParameters<typeof AcpTransport>[1]['request'] = () => ({})) {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames: unknown[] = [];
  input.on('data', chunk => frames.push(JSON.parse(String(chunk))));
  const transport = new AcpTransport({ input, output }, { notification() {}, request });
  const send = (frame: unknown) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame as object })}\n`);
  return { input, output, transport, send, frames };
}

describe('ACP line framing and error ownership', () => {
  it('reassembles split UTF-8 frames, correlates out-of-order replies, and carries RPC errors', async () => {
    const { output, transport } = wire();
    const first = transport.request('first', {});
    const second = transport.request('second', {});
    const failure = transport.request('third', {}).catch(error => error);
    const bytes = Buffer.from('{"jsonrpc":"2.0","id":2,"result":{"text":"ą"}}\n');
    const split = bytes.indexOf(Buffer.from('ą')) + 1;
    output.write(bytes.subarray(0, split));
    output.write(bytes.subarray(split));
    output.end('{"jsonrpc":"2.0","id":1,"result":{}}\n{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"unsupported"}}\n');
    expect(await first).toEqual({});
    expect(await second).toEqual({ text: 'ą' });
    expect(await failure).toBeInstanceOf(AcpRpcError);
    expect(await transport.completion).toBeUndefined();
  });

  it.each(['bad-json\n', '{"jsonrpc":"2.0","id":1}\n'])('rejects pending requests on invalid frames: %s', async frame => {
    const { output, transport } = wire();
    const pending = transport.request('initialize', {}).catch(error => error);
    output.end(frame);
    expect(await transport.completion).toBeInstanceOf(Error);
    expect(await pending).toBeInstanceOf(Error);
    await expect(transport.request('later', {})).rejects.toThrow();
  });

  it('rejects receipts on EOF and on input failure', async () => {
    for (const reason of ['eof', 'input']) {
      const { output, input, transport } = wire();
      const pending = transport.request('session/prompt', {}).catch(error => error);
      if (reason === 'input') input.emit('error', new Error('broken pipe'));
      output.end();
      expect(await pending).toBeInstanceOf(Error);
      await transport.completion;
    }
  });
});

describe('ACP capability negotiation', () => {
  it.each([false, true])('requires explicit opt-in for session/load when resume is absent: %s', async fallback => {
    const input = new PassThrough(); const output = new PassThrough();
    const methods: string[] = [];
    input.on('data', chunk => {
      const frame = JSON.parse(String(chunk)); methods.push(frame.method);
      const result = frame.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } } : {};
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })}\n`);
    });
    const session = new AcpSession({ input, output }, { backend: 'fixture', clientInfo: { name: 'test', version: '1' } });
    await session.initialize();
    const opened = session.open({ cwd: '/repo', sessionId: 'saved', loadFallback: fallback });
    if (fallback) { expect(await opened).toBe('saved'); expect(methods).toEqual(['initialize', 'session/load']); }
    else { await expect(opened).rejects.toThrow('explicit opt-in'); expect(methods).toEqual(['initialize']); }
    output.end(); await session.transport.completion;
  });
});

it('maps partial tool updates, reasoning, plans and USD usage without clearing absent values', () => {
  const events: AgentEvent[] = []; const ui: UiEvent[] = [];
  const mapper = new AcpEvents({ event: e => events.push(e), uiEvent: e => ui.push(e) }, {});
  mapper.begin();
  mapper.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking' } });
  // oxlint-disable-next-line cez/test-enum-literal -- This is an ACP tool status, not a Squawk run or step status.
  mapper.update({ sessionUpdate: 'tool_call', toolCallId: 'edit', name: 'edit_file', title: 'Edit file', kind: 'edit', status: 'pending', rawInput: { path: 'a' } });
  mapper.update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'in_progress', rawInput: null, content: [{ type: 'diff', path: 'a', oldText: 'old', newText: 'new' }], locations: [{ path: 'a', line: 1 }] });
  mapper.update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', name: null, rawOutput: 'done' });
  mapper.update({ sessionUpdate: 'plan', entries: [{ content: 'Edit file', status: 'completed', priority: 'high' }] });
  mapper.update({ sessionUpdate: 'usage_update', used: 12, size: 1024, cost: { amount: 0.1, currency: 'USD' } });
  mapper.finish('end_turn');
  expect(ui).toContainEqual({ type: 'item.completed', item: { kind: 'reasoning', id: 'acp-item-2', text: 'Thinking' } });
  expect(ui).toContainEqual({ type: 'item.completed', item: { kind: 'tool', id: 'edit', name: 'edit_file', title: 'Edit file', toolKind: 'edit', status: 'completed', input: { path: 'a' }, output: 'done', diffs: [{ path: 'a', oldText: 'old', newText: 'new' }], locations: [{ path: 'a', line: 1 }] } });
  expect(events.filter(e => e.type === 'tool-call')).toHaveLength(1);
  expect(ui).toContainEqual({ type: 'plan.updated', entries: [{ content: 'Edit file', status: 'completed', priority: 'high' }] });
  expect(events).toContainEqual({ type: 'cost', usd: 0.1 });
  expect(ui).toContainEqual({ type: 'usage.updated', usage: { input: 0, output: 0, total: 12, contextWindow: 1024 }, costUsd: 0.1 });
});

it.each(['completed', 'failed'])('completes a first terminal tool update and preserves its image: %s', status => {
  const events: AgentEvent[] = []; const ui: UiEvent[] = [];
  const mapper = new AcpEvents({ event: e => events.push(e), uiEvent: e => ui.push(e) }, {});
  mapper.begin();
  mapper.update({ sessionUpdate: 'tool_call_update', toolCallId: 'screenshot', status,
    content: [{ type: 'content', content: { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' } },
      { type: 'content', content: { type: 'text', text: 'Screenshot captured' } }],
  });
  expect(events).toContainEqual({ type: 'tool-result', toolCallId: 'screenshot', result: 'Screenshot captured', isError: status === 'failed' });
  expect(ui).toContainEqual(expect.objectContaining({ type: 'item.completed', item: expect.objectContaining({ id: 'screenshot', status }) }));
  expect(events).toContainEqual({ type: 'image', mediaType: 'image/png', data: 'aW1hZ2U=' });
  expect(ui).toContainEqual({ type: 'image', itemId: 'screenshot', mediaType: 'image/png', data: 'aW1hZ2U=' });
  mapper.finish('end_turn');
});
