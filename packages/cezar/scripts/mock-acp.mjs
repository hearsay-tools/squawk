#!/usr/bin/env node
// ACP v1 encoder. Shared scenarios own content; this module owns native framing and timing.
import readline from 'node:readline';
import { appendFileSync, closeSync } from 'node:fs';
import { lifecycleCall, ciPrompt, toolPrompt, probeCiTool } from './mock-ci-tool.mjs';
import { scenarioFor, play } from './mock-scenario.mjs';
import { withoutSessionContextParts } from './mock-session-context.mjs';
import { loadControls } from './mock-controls.mjs';
import { waitForRelease } from './mock-lifecycle.mjs';
import { answerNudge } from './mock-nudge.mjs';
import { PI_FAILURES } from './mock-provider-failures.mjs';

if (process.argv.includes('--version')) { console.log('antigravity_extensions/acp_server 1.5.0'); process.exit(0); }
const antigravity = process.argv.includes('--uid=');
const { failureControl, delivery } = await loadControls({ failure: ['provider', 'unread'], delivery: ['reject', 'hold-ack', 'hold-response'] });
const write = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const reply = (id, result) => write({ id, result });
let sessionId = 'mock-acp-session';
let active;
let sessionParams = {};
const steers = [];
const latePrompts = [];
if (process.env.CEZ_MOCK_ARGS_FILE) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${JSON.stringify(process.argv.slice(2))}\n`);
let serverId = 0;
const pending = new Map();
const update = value => write({ method: 'session/update', params: { sessionId, update: value } });
const content = (sessionUpdate, text) => update({ sessionUpdate, content: { type: 'text', text } });
const request = (method, params, nativeId) => new Promise(resolve => {
  const id = nativeId ?? `agent-${++serverId}`;
  pending.set(id, resolve); write({ id, method, params });
});
const context = {
  runner: 'acp', session: {}, nativeFailureControl: Boolean(failureControl),
  lifecycle: ([name, args]) => lifecycleCall('acp', sessionParams, name, args),
  toolPrompt: text => toolPrompt('acp', sessionParams, text),
  ciPrompt: text => ciPrompt('acp', sessionParams, text),
  async crash(text) { const { crashWithStderr } = await import('./mock-runner-crash.mjs'); if (crashWithStderr(text, '{"jsonrpc":"2.0","method":"session/update')) await new Promise(() => {}); },
};
function encoder(turn) {
  const send = value => { if (active === turn && !turn.cancelled) update(value); };
  const text = (sessionUpdate, value) => send({ sessionUpdate, content: { type: 'text', text: value } });
  return {
    open() {},
    text: ({ parts }) => text('agent_message_chunk', parts.join('')),
    reasoning: step => text('agent_thought_chunk', step.text),
    toolStart: ({ call }) => send({ sessionUpdate: 'tool_call', toolCallId: call.id, title: call.name, kind: 'other', status: 'in_progress', rawInput: call.input }),
    toolEnd: ({ call }) => send({ sessionUpdate: 'tool_call_update', toolCallId: call.id, status: call.isError ? 'failed' : 'completed', rawOutput: call.output }),
    progress: () => send({ sessionUpdate: 'usage_update', used: 7, size: 1048576 }),
    end: ({ error } = {}) => { if (error) text('agent_message_chunk', `Agent execution error: ${PI_FAILURES[error] ?? error}`); },
    readSteers: ({ late }) => { turn.lateWindow = late; if (!late) echoSteers(turn); return []; },
    closeInput: () => closeSync(0),
    child: (_step, playChild) => playChild(encoder(turn)),
    reply: ({ prompt }) => text('agent_message_chunk', `Investigating: ${prompt}`),
  };
}
const promptText = frame => withoutSessionContextParts(frame.params.prompt).filter(block => block.type === 'text').map(block => block.text).join('\n');
function acknowledge(frame, result, text) {
  if (delivery) delivery.ack(text, () => reply(frame.id, result));
  else reply(frame.id, result);
}
async function prompt(frame) {
  const text = promptText(frame);
  if (delivery?.rejects(text)) { write({ id: frame.id, error: { code: -32000, message: 'owned turn rejected' } }); return; }
  if (active?.late) {
    const turn = active;
    reply(turn.frameId, { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } });
    turn.mainReplied = true;
    content('agent_message_chunk', 'late successor');
    await request('session/request_permission', { sessionId,
      toolCall: { toolCallId: 'late-tool', title: 'Run generate_image?', kind: 'other' },
      options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }] });
    reply(frame.id, { stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 6, totalTokens: 11 } });
    turn.releaseLate(); return;
  }
  if (active) {
    if (active.lateWindow) { latePrompts.push(frame); return; }
    steers.push(text);
    content('agent_message_chunk', 'Agent connection was lost and could not be re-established: Concurrent receive_steps() calls are not supported on this connection.');
    acknowledge(frame, { stopReason: 'end_turn' }, text); return;
  }
  let cancel;
  const turn = { cancelled: false, cancelledPromise: new Promise(resolve => { cancel = resolve; }), cancel: () => { turn.cancelled = true; cancel(); } };
  turn.frameId = frame.id;
  active = turn;
  try {
    // An unread crash stops before the first yield can accept a concurrent steer.
    if (failureControl?.failure === 'unread' && failureControl.failureFor(text) === 'unread') process.exit(1);
    await delivery?.holdResponse(text);
    const failure = await failureControl?.failureFor(text);
    if (failure) content('agent_message_chunk', `Agent execution error: ${PI_FAILURES[failure]}`);
    else await runPrompt(answerNudge(text), turn);
    if (failure) steers.length = 0;
    else echoSteers(turn);
    if (!turn.cancelled) update({ sessionUpdate: 'usage_update', used: 7, size: 1048576 });
    if (!turn.mainReplied) acknowledge(frame, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }, text);
  } catch (error) { write({ id: frame.id, error: { code: -32603, message: error.message } }); }
  finally { active = undefined; const late = latePrompts.shift(); if (late) void prompt(late); }
}
function echoSteers(turn) {
  if (turn.cancelled) return;
  for (const text of steers.splice(0)) content('agent_message_chunk', text.startsWith('/probe-') ? `TRIGGER-FIXTURE ${text}` : `saw: ${text}`);
}
async function runPrompt(text, turn) {
  // The managed recovery prompt is supplied as the resumed system prompt.
  if (sessionParams._meta?.antigravity?.systemPrompt?.append?.includes('mock:approval')) return permissionPrompt('mock:approval', turn);
  if (text.includes('mock:acp-late-steer')) {
    turn.late = true;
    const released = new Promise(resolve => { turn.releaseLate = resolve; });
    update({ sessionUpdate: 'tool_call', toolCallId: 'steer-now', title: 'Read', status: 'completed', rawOutput: 'ready' });
    await released; return;
  }
  if (process.env.CEZ_MOCK_PERMISSION_PROBE === '1') await policyProbe();
  if (text.includes('mock:acp-extended-updates')) extendedUpdates();
  if (/mock:(?:acp-permission|acp-ask|approval|ask-native|ask-bad|permission-default)/.test(text)) return permissionPrompt(text, turn);
  if (context.session.resumeAfterAsk && text.trim().startsWith('Question:')) {
    content('agent_message_chunk', `Answer received${await context.lifecycle(['cezar_done', {}])}`); return;
  }
  if (text.startsWith('/probe-')) { content('agent_message_chunk', `TRIGGER-FIXTURE ${text}`); return; }
  if (process.env.CEZ_MOCK_CI_PR) await probeCiTool('acp', sessionParams);
  const scenario = scenarioFor(text, context);
  const wire = encoder(turn);
  if (scenario) {
    if (scenario.name === 'no-progress' && text.includes('ignore-term')) ignoreEof = true;
    await Promise.race([play(scenario, wire), turn.cancelledPromise]);
    if (scenario.name === 'no-progress') await turn.cancelledPromise;
  }
  else {
    wire.text({ parts: ['Investigating: ', text] });
    const call = { id: 'read-1', name: 'read', input: { path: 'README.md' }, output: 'mock file' };
    wire.toolStart({ call }); wire.toolEnd({ call });
  }
}
async function permissionPrompt(text, turn) {
  const nativeAsk = text.includes('mock:ask-native');
  const defaultPermission = text.includes('mock:permission-default');
  const malformed = text.includes('mock:approval-malformed') || text.includes('mock:ask-bad');
  const toolCall = { toolCallId: nativeAsk ? 'interaction_12345678' : 'permission-tool',
    title: nativeAsk ? 'Which test library?' : defaultPermission ? 'Run run_command?' : 'Run generate_image?',
    kind: defaultPermission ? 'execute' : 'other', rawInput: defaultPermission ? { CommandLine: 'pwd' } : {} };
  const options = nativeAsk ? [{ optionId: '1', name: 'Vitest', kind: 'allow_once' }, { optionId: '2', name: 'Node test', kind: 'allow_once' }]
    : [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' }];
  const responsePromise = request('session/request_permission', { sessionId, toolCall, options: malformed ? [] : options }, text.includes('long-id') ? 'native-id-'.repeat(64) : undefined);
  if (text.includes('mock:approval-turn-end')) {
    await waitForRelease();
    content('agent_message_chunk', `Turn ended with the approval still pending.${await context.lifecycle(['cezar_done', {}])}`);
    return;
  }
  const response = await responsePromise;
  if (turn.cancelled) return;
  if (malformed) content('agent_message_chunk', `Malformed permission refused${await context.lifecycle(['cezar_done', {}])}`);
  else if (nativeAsk || text.includes('mock:acp-')) content('agent_message_chunk', JSON.stringify(response) + (text.includes('mock:resume-cezar-done') ? await context.lifecycle(['cezar_done', {}]) : ''));
  else content('agent_message_chunk', `Approval response: ${response.outcome.optionId === 'allow-once' ? 'allow' : 'deny'}${await context.lifecycle(['cezar_done', {}])}`);
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

async function policyProbe() {
  const calls = [
    { kind: 'read', title: 'Run read_file?', rawInput: { path: 'README.md' } },
    { kind: 'execute', title: 'git status', rawInput: { CommandLine: 'git status --short' } },
    { kind: 'execute', title: 'pwd', rawInput: { CommandLine: 'pwd' } },
  ];
  for (const [index, call] of calls.entries()) {
    await request('session/request_permission', { sessionId, toolCall: { toolCallId: `policy-tool-${index}`, ...call },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
    }, `policy-${index}`);
  }
}
function recorded(frame) {
  // Connection credentials stay in memory; recordings retain only their structure.
  const copy = structuredClone(frame);
  for (const server of copy.params?.mcpServers ?? []) {
    if (server.type !== 'http') continue;
    server.url = 'http://127.0.0.1:0/mcp'; server.headers = [{ name: 'Authorization', value: '<session-token>' }];
  }
  return JSON.stringify(copy);
}

async function handle(frame) {
  if (process.env.CEZ_MOCK_STDIN_FILE) appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${recorded(frame)}\n`);
  if (process.env.CEZ_MOCK_ARGS_FILE) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${recorded(frame)}\n`);
  if (!frame.method) { pending.get(frame.id)?.(frame.result); pending.delete(frame.id); return; }
  switch (frame.method) {
    case 'initialize': reply(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true, sse: true } }, authMethods: [{ id: 'mock-key', name: 'Mock key' }], agentInfo: { name: 'mock-acp', version: '1.0.0' } }); break;
    case 'authenticate': reply(frame.id, {}); break;
    case 'session/new':
      sessionParams = frame.params; sessionId = 'mock-acp-session';
      update({ sessionUpdate: 'usage_update', used: 0, size: 1048576 });
      reply(frame.id, { sessionId, configOptions: [{ id: 'thinking_level', category: 'thought_level', currentValue: 'medium' }] }); break;
    case 'session/resume': case 'session/load': context.session.resumeAfterAsk = true; sessionParams = frame.params; sessionId = frame.params.sessionId; reply(frame.id, { configOptions: [{ id: 'thinking_level', category: 'thought_level', currentValue: 'medium' }] }); break;
    case 'session/set_config_option': reply(frame.id, { configOptions: antigravity ? [{ id: 'thinking_level', category: 'thought_level', currentValue: frame.params.configId === 'thinking_level' ? frame.params.value : 'medium' }] : [{ id: frame.params.configId, currentValue: frame.params.value }] }); break;
    case 'session/prompt': await prompt(frame); break;
    case 'session/cancel': active?.cancel(); break;
    default: if (frame.id !== undefined) write({ id: frame.id, error: { code: -32601, message: `Unknown method: ${frame.method}` } });
  }
}

let ignoreEof = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => { void handle(JSON.parse(line)); });
lines.on('close', () => {
  active?.cancel(); for (const resolve of pending.values()) resolve({ outcome: { outcome: 'cancelled' } });
  if (!ignoreEof) process.exit(0);
});
