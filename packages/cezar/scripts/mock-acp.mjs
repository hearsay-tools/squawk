#!/usr/bin/env node
// ACP v1 stdio encoder. Scenarios stay in mock-scenario.mjs; this file owns only the wire.
import readline from 'node:readline';
import { appendFileSync } from 'node:fs';
import { scenarioFor, play } from './mock-scenario.mjs';

const write = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const reply = (id, result) => write({ id, result });
let sessionId = 'mock-acp-session';
let active;
let serverId = 0;
const pending = new Map();
const update = value => write({ method: 'session/update', params: { sessionId, update: value } });
const content = (sessionUpdate, text) => update({ sessionUpdate, content: { type: 'text', text } });
const request = (method, params) => new Promise(resolve => {
  const id = `agent-${++serverId}`;
  pending.set(id, resolve);
  write({ id, method, params });
});
const context = {
  runner: 'acp', session: {},
  // The shared layer has no provider MCP bridge. Its consumer supplies one.
  unsupported: ['cezar-done', 'cezar-ask', 'cezar-wait', 'hold-cezar-done', 'hold-cezar-ask', 'busy-progress', 'multi-pr-refs', 'autonomous', 'silent-tail', 'cezar-tool', 'ci-wait', 'crash-stderr'],
};
function encoder(turn) {
  const send = value => { if (active === turn && !turn.cancelled) update(value); };
  const text = (sessionUpdate, value) => send({ sessionUpdate, content: { type: 'text', text: value } });
  return {
    open() {},
    text: ({ parts }) => { for (const part of parts) text('agent_message_chunk', part); },
    reasoning: step => text('agent_thought_chunk', step.text),
    toolStart: ({ call }) => send({ sessionUpdate: 'tool_call', toolCallId: call.id, title: call.name, kind: 'other', status: 'in_progress', rawInput: call.input }),
    toolEnd: ({ call }) => send({ sessionUpdate: 'tool_call_update', toolCallId: call.id, status: call.isError ? 'failed' : 'completed', rawOutput: call.output }),
    progress: () => send({ sessionUpdate: 'usage_update', used: 7, size: 1048576 }),
    end: ({ error } = {}) => { if (error) throw new Error(`mock provider ${error}`); },
    readSteers: () => [],
    hold: () => turn.cancelledPromise,
    closeInput: () => process.stdin.destroy(),
    child: () => { throw new Error('ACP mock has no subagent extension'); },
    reply: ({ prompt }) => text('agent_message_chunk', `Investigating: ${prompt}`),
  };
}

async function prompt(frame) {
  if (active) { write({ id: frame.id, error: { code: -32000, message: 'Prompt already active' } }); return; }
  let cancel;
  const turn = { cancelled: false, cancelledPromise: new Promise(resolve => { cancel = resolve; }), cancel: () => { turn.cancelled = true; cancel(); } };
  active = turn;
  const text = frame.params.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n');
  try {
    if (text.includes('mock:acp-extended-updates')) extendedUpdates();
    if (text.includes('mock:acp-permission') || text.includes('mock:acp-ask')) {
      const result = await request('session/request_permission', { sessionId,
        toolCall: { toolCallId: 'permission-tool', title: text.includes('mock:acp-ask') ? 'Question' : 'Execute command', rawInput: { command: 'pwd' } },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' }],
      });
      if (!turn.cancelled) content('agent_message_chunk', JSON.stringify(result));
    } else {
      const scenario = scenarioFor(text, context);
      const wire = encoder(turn);
      if (scenario) await Promise.race([play(scenario, wire), turn.cancelledPromise]);
      else {
        wire.text({ parts: ['Investigating: ', text] });
        const call = { id: 'read-1', name: 'read', input: { path: 'README.md' }, output: 'mock file' };
        wire.toolStart({ call }); wire.toolEnd({ call });
      }
    }
    if (!turn.cancelled) update({ sessionUpdate: 'usage_update', used: 7, size: 1048576 });
    reply(frame.id, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn' });
  } catch (error) { write({ id: frame.id, error: { code: -32603, message: error.message } }); }
  finally { active = undefined; }
}

function extendedUpdates() {
  content('agent_message_chunk', 'before extensions');
  update({ sessionUpdate: 'tool_call', toolCallId: 'extended-tool', title: 'Vendor tool', kind: 'vendor_extension', status: 'in_progress' });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'extended-tool', status: 'vendor_waiting' });
  update({ sessionUpdate: 'plan', entries: [{ content: 'Vendor plan', status: 'cancelled', priority: 'high' }] });
  update({ sessionUpdate: 'usage_update', used: 3 });
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', uri: 'file:///repo/a' } });
  update({ sessionUpdate: 123 });
  update({ sessionUpdate: 'vendor_update', value: {} });
  update({ sessionUpdate: 'tool_call', toolCallId: 'bad-tool', title: 42 });
  write({ method: 'session/update', params: { update: null } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: 'extended-tool', status: 'completed', rawOutput: 'extension survived' });
}

async function handle(frame) {
  if (process.env.CEZ_MOCK_STDIN_FILE) appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${JSON.stringify(frame)}\n`);
  if (!frame.method) { pending.get(frame.id)?.(frame.result); pending.delete(frame.id); return; }
  switch (frame.method) {
    case 'initialize': reply(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true, sse: true } }, authMethods: [{ id: 'mock-key', name: 'Mock key' }], agentInfo: { name: 'mock-acp', version: '1.0.0' } }); break;
    case 'authenticate': reply(frame.id, {}); break;
    case 'session/new':
      update({ sessionUpdate: 'usage_update', used: 0, size: 1048576 });
      reply(frame.id, { sessionId, configOptions: [] }); break;
    case 'session/resume': case 'session/load': sessionId = frame.params.sessionId; reply(frame.id, { configOptions: [] }); break;
    case 'session/set_config_option': reply(frame.id, { configOptions: [{ id: frame.params.configId, currentValue: frame.params.value }] }); break;
    case 'session/prompt': await prompt(frame); break;
    case 'session/cancel': active?.cancel(); break;
    default: if (frame.id !== undefined) write({ id: frame.id, error: { code: -32601, message: `Unknown method: ${frame.method}` } });
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => { void handle(JSON.parse(line)); });
lines.on('close', () => { active?.cancel(); for (const resolve of pending.values()) resolve({ outcome: { outcome: 'cancelled' } }); });
