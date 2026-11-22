#!/usr/bin/env node
// ACP v1 encoder. Shared scenarios own content; this module owns native framing and timing.
import readline from 'node:readline';
import { appendFileSync, closeSync, existsSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { lifecycleCall, ciPrompt, toolPrompt, probeCiTool } from './mock-ci-tool.mjs';
import { scenarioFor, play } from './mock-scenario.mjs';
import { withoutSessionContextParts } from './mock-session-context.mjs';
import { loadControls } from './mock-controls.mjs';
import { waitForRelease } from './mock-lifecycle.mjs';
import { answerNudge } from './mock-nudge.mjs';
import { PI_FAILURES } from './mock-provider-failures.mjs';
import { knownSession, saveSession } from './mock-acp-sessions.mjs';

// The Antigravity CLI's identity: a bare version and a help text that lists its acp command.
if (process.argv.includes('--version')) { console.log('1.5.14'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('Usage of antigravity:\n  acp  Start the Agent Client Protocol (ACP) stdio server'); process.exit(0); }
const flag = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
if (process.argv.includes('--login')) {
  const { mockLogin } = await import('./mock-acp-login.mjs');
  process.exit(await mockLogin(flag('--gemini-dir')));
}
let antigravity = false;
const { failureControl, delivery } = await loadControls({ failure: ['provider', 'unread'], delivery: ['reject', 'hold-ack', 'hold-response'] });
const write = frame => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...frame })}\n`);
const reply = (id, result) => write({ id, result });
let sessionId = 'mock-acp-session';
let active;
let sessionParams = {};
const steers = [];
let mcpTurns = 0;
let pendingAsk;
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
    end: ({ error } = {}) => { if (error) text('agent_message_chunk', `\n⚠ agent executor error: ${PI_FAILURES[error] ?? error}`); },
    // The CLI reads a steer in the running turn, early or late.
    readSteers: () => { echoSteers(turn); return []; },
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
  if (text === 'mock:account-homes') { accountHomes(frame); return; }
  if (delivery?.rejects(text)) { write({ id: frame.id, error: { code: -32000, message: 'owned turn rejected' } }); return; }
  if (active) { steer(frame, text); return; }
  let cancel;
  const turn = { cancelled: false, cancelledPromise: new Promise(resolve => { cancel = resolve; }), cancel: () => { turn.cancelled = true; cancel(); } };
  turn.frameId = frame.id;
  active = turn;
  if (pendingAsk) { await answerAsk(text); finishAnswer(frame, text); return; }
  try { await playTurn(frame, text, turn); }
  catch (error) { write({ id: (turn.carrier ?? frame).id, error: { code: -32603, message: error.message } }); }
  finally { active = undefined; await turn.afterTurn?.(); }
}
function finishAnswer(frame, text) {
  update({ sessionUpdate: 'usage_update', used: 7, size: 1048576 });
  active = undefined;
  acknowledge(frame, { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }, text);
}
async function playTurn(frame, text, turn) {
  // An unread crash stops before the first yield can accept a concurrent steer.
  if (failureControl?.failure === 'unread' && failureControl.failureFor(text) === 'unread') process.exit(1);
  await delivery?.holdResponse(text);
  const failure = await failureControl?.failureFor(text);
  if (failure) { content('agent_message_chunk', `\n⚠ agent executor error: ${PI_FAILURES[failure]}`); steers.length = 0; }
  else { await runPrompt(answerNudge(text), turn); echoSteers(turn); }
  if (!turn.cancelled) update({ sessionUpdate: 'usage_update', used: 7, size: 1048576 });
  acknowledge(turn.carrier ?? frame, { stopReason: turn.cancelled ? 'cancelled' : 'end_turn', usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } }, turn.carrierText ?? text);
}
/** A steer ends the running prompt at once; the steer's own response ends the turn. */
function steer(frame, text) {
  steers.push(text);
  if (!active.carrier) reply(active.frameId, { stopReason: 'end_turn' });
  else acknowledge(active.carrier, { stopReason: 'end_turn' }, active.carrierText);
  active.carrier = frame; active.carrierText = text;
}
function accountHomes(frame) {
  content('agent_message_chunk', JSON.stringify({ gemini: flag('--gemini-dir'), appData: flag('--app-data-dir'), geminiHome: process.env.GEMINI_HOME, home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, ssh: process.env.SSH_CONNECTION }));
  update({ sessionUpdate: 'usage_update', used: 7, size: 1048576 });
  reply(frame.id, { stopReason: 'end_turn' });
}
function authenticate(frame) {
  if (frame.params.methodId !== 'oauth-personal' || existsSync(join(flag('--gemini-dir') ?? '.', 'antigravity-cli', 'mock-login.json'))) { reply(frame.id, {}); return; }
  write({ id: frame.id, error: { code: -32603, message: 'No browser is available here (this is a remote (SSH) session, so the browser\'s sign-in redirect can\'t reach this machine). Run `agy acp --login` in a terminal on this machine, then retry; or use a Gemini API key.' } });
}
function echoSteers(turn) {
  if (turn.cancelled) return;
  for (const text of steers.splice(0)) content('agent_message_chunk', text.startsWith('/probe-') ? `TRIGGER-FIXTURE ${text}` : `saw: ${text}`);
}
async function runtimeProbe(text, turn) {
  if (text === 'mock:acp-mcp-name-limit') {
    const server = sessionParams.mcpServers[0];
    const response = await fetch(server.url, { method: 'POST', headers: Object.fromEntries(server.headers.map(header => [header.name, header.value])), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const { result } = await response.json();
    // The CLI drops a tool whose qualified name breaks its 64-character limit.
    if (++mcpTurns > 1 && result.tools.some(tool => !/^[a-zA-Z0-9_-]{1,64}$/.test(`mcp_${server.name}_${tool.name}`))) {
      content('agent_message_chunk', 'MISSING'); return true;
    }
    const toolCall = { toolCallId: `mcp-${mcpTurns}`, name: `mcp_${server.name}_cezar_ask`, title: `Run mcp_${server.name}_cezar_ask`, kind: 'other', rawInput: {} };
    update({ sessionUpdate: 'tool_call', ...toolCall, status: 'pending' });
    const answer = await request('session/request_permission', { sessionId, toolCall, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] });
    if (answer.outcome?.optionId !== 'allow') throw new Error('Squawk MCP permission was not trusted');
    update({ sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: 'completed', rawOutput: 'Asked' });
    content('agent_message_chunk', mcpTurns === 1 ? 'FIRST_OK' : 'SECOND_OK'); return true;
  }
  if (text === 'mock:acp-detached-command') {
    // Native harness commands lead their own sessions. A stubborn one tests the
    // runner's cleanup after the harness exits, beyond normal cancellation.
    const command = spawn(process.execPath, ['-e', `process.on('SIGTERM',()=>{}); setInterval(()=>{try{process.kill(${process.ppid},0)}catch{process.kill(process.pid,'SIGKILL')}},1000).unref(); setInterval(()=>{},1000); console.log('ready')`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }); // stubborn-child: guarded by the test worker, to survive harness exit and prove runner cleanup.
    await once(command.stdout, 'data');
    update({ sessionUpdate: 'tool_call', toolCallId: 'foreground', title: 'run_command', kind: 'execute', status: 'in_progress', rawInput: { pid: command.pid } });
    await turn.cancelledPromise;
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'foreground', status: 'failed', rawOutput: 'Cancelled by agent' });
    return true;
  }
  if (text === 'mock:acp-runtime-workspace') {
    writeFileSync(join(sessionParams.cwd, 'workspace-proof'), JSON.stringify({ processCwd: process.cwd(), sessionCwd: sessionParams.cwd, additionalDirectories: sessionParams.additionalDirectories }));
    return true;
  }
  if (text === 'mock:acp-eager-done') {
    content('agent_message_chunk', `Done${await context.lifecycle(['cezar_done', {}])}`); return true;
  }
  return false;
}
async function runPrompt(text, turn) {
  if (await runtimeProbe(text, turn)) return;
  if (text.includes('mock:permission-late')) return latePermission(turn);
  if (text.includes('mock:late-error')) {
    // A background command wakes the idle session, and that model step fails.
    content('agent_message_chunk', 'Started in the background.');
    turn.afterTurn = async () => { content('agent_message_chunk', '\n⚠ agent executor error: 503 Service Unavailable'); update({ sessionUpdate: 'usage_update', used: 7, size: 1048576 }); };
    return;
  }
  if (scheduleWakeup(text)) return;
  if (process.env.CEZ_MOCK_PERMISSION_PROBE === '1') await policyProbe();
  if (text.includes('mock:acp-extended-updates')) extendedUpdates();
  if (/mock:(?:ask-native|ask-bad)/.test(text)) return askQuestion(text);
  // A resumed process holds no open question: the answer arrives as the opening prompt.
  if (context.session.resumeAfterAsk && /^Question:\s*(?:Vitest|Node test)\s*$/m.test(text)) {
    content('agent_message_chunk', `Answer received: ${text.trim()}${await context.lifecycle(['cezar_done', {}])}`); return;
  }
  if (/mock:(?:acp-permission|acp-ask|approval|permission-default)/.test(text)) return permissionPrompt(text, turn);
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
  const defaultPermission = text.includes('mock:permission-default');
  const malformed = text.includes('mock:approval-malformed');
  const toolCall = { toolCallId: 'permission-tool', name: defaultPermission ? 'run_command' : 'generate_image',
    title: defaultPermission ? 'pwd' : 'Run generate_image',
    kind: defaultPermission ? 'execute' : 'other', rawInput: defaultPermission ? { CommandLine: 'pwd' } : {} };
  let options = [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' }];
  if (text.includes('one-option')) options = options.slice(0, 1);
  const responsePromise = request('session/request_permission', { sessionId, toolCall, options: malformed ? [] : options }, text.includes('long-id') ? 'native-id-'.repeat(64) : undefined);
  if (text.includes('mock:approval-turn-end')) {
    await waitForRelease();
    content('agent_message_chunk', `Turn ended with the approval still pending.${await context.lifecycle(['cezar_done', {}])}`);
    return;
  }
  const response = await responsePromise;
  if (turn.cancelled) return;
  if (malformed) content('agent_message_chunk', `Malformed permission refused${await context.lifecycle(['cezar_done', {}])}`);
  else if (text.includes('mock:acp-')) content('agent_message_chunk', JSON.stringify(response));
  else content('agent_message_chunk', `Approval response: ${response.outcome.optionId === 'allow-once' ? 'allow' : 'deny'}${await context.lifecycle(['cezar_done', {}])}`);
}

/** The native timer stays open until it fires; this turn ends at once. */
function scheduleWakeup(text) {
  const wakeup = /mock:schedule-wakeup:(\d+)/.exec(text);
  if (!wakeup) return false;
  update({ sessionUpdate: 'tool_call', toolCallId: 'call_schedule', name: 'schedule', title: 'Run schedule', kind: 'other', status: 'in_progress', rawInput: { DurationSeconds: Number(wakeup[1]), Prompt: 'wake up' } });
  content('agent_message_chunk', 'Scheduled.');
  return true;
}
/** ask_question ends the prompt with the question as text; the next prompt is the answer. */
async function askQuestion(text) {
  const questions = text.includes('mock:ask-bad') ? [] : [{ question: 'Which test library?', options: ['(Recommended) Vitest', 'Node test'] }];
  pendingAsk = { id: 'call_ask_question', done: text.includes('mock:resume-cezar-done') };
  update({ sessionUpdate: 'tool_call', toolCallId: pendingAsk.id, name: 'ask_question', title: 'Run ask_question', kind: 'other', status: 'in_progress', rawInput: { questions } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: pendingAsk.id, name: 'ask_question', status: 'pending' });
  if (!questions.length) {
    update({ sessionUpdate: 'tool_call_update', toolCallId: pendingAsk.id, status: 'failed', rawOutput: { output: 'questions must not be empty' } });
    pendingAsk = undefined;
    content('agent_message_chunk', `Malformed permission refused${await context.lifecycle(['cezar_done', {}])}`); return;
  }
  content('agent_message_chunk', '\nWhich test library?\n- [1] (Recommended) Vitest\n- [2] Node test\n');
}
async function answerAsk(text) {
  const ask = pendingAsk; pendingAsk = undefined;
  update({ sessionUpdate: 'tool_call_update', toolCallId: ask.id, status: 'completed', rawOutput: { output: text } });
  content('agent_message_chunk', `Answer received: ${text}${ask.done || context.session.resumeAfterAsk ? await context.lifecycle(['cezar_done', {}]) : ''}`);
}
/** P8: the turn ends after cezar_done; a background command then wakes the idle session, which asks. */
async function latePermission(turn) {
  content('agent_message_chunk', `The turn finished before the late request.${await context.lifecycle(['cezar_done', {}])}`);
  turn.afterTurn = async () => {
    const toolCall = { toolCallId: 'call_late', name: 'generate_image', title: 'Run generate_image', kind: 'other', rawInput: {} };
    update({ sessionUpdate: 'tool_call', ...toolCall, status: 'in_progress' });
    const response = await request('session/request_permission', { sessionId, toolCall,
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Deny', kind: 'reject_once' }] });
    const allowed = response?.outcome?.optionId === 'allow-once';
    update({ sessionUpdate: 'tool_call_update', toolCallId: toolCall.toolCallId, status: allowed ? 'completed' : 'failed', rawOutput: { output: '' } });
    content('agent_message_chunk', `Approval response: ${allowed ? '{"reply":"once"}' : '{"reply":"reject"}'}${await context.lifecycle(['cezar_done', {}])}`);
    update({ sessionUpdate: 'usage_update', used: 7, size: 1048576 });
  };
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
let mintedId;
function recorded(frame) {
  // Connection credentials stay in memory; recordings retain only their structure.
  const copy = structuredClone(frame);
  for (const server of copy.params?.mcpServers ?? []) {
    if (server.type !== 'http') continue;
    server.url = 'http://127.0.0.1:0/mcp'; server.headers = [{ name: 'Authorization', value: '<session-token>' }];
  }
  // This process's session/new id differs per process; two recordings of the same requests compare
  // equal. A resumed id is the caller's and stays as it is.
  if (mintedId && copy.params?.sessionId === mintedId) copy.params.sessionId = 'mock-acp-session';
  return JSON.stringify(copy);
}

function setConfig(frame) {
  if (antigravity && frame.params.configId === 'model' && frame.params.value.startsWith('mock-')) {
    console.error('/archive/google/genai/types.py:18270: SyntaxWarning: invalid escape sequence');
    if (frame.params.value === 'mock-invalid-model') {
      write({ id: frame.id, error: { code: -32602, message: 'Requested model is unavailable' } }); return;
    }
    if (frame.params.value === 'mock-no-thinking') { reply(frame.id, { configOptions: [] }); return; }
    if (frame.params.value === 'mock-low-thinking') {
      reply(frame.id, { configOptions: [{ id: 'thought_level', category: 'thought_level', options: [{ value: 'low', name: 'Low' }] }] }); return;
    }
  }
  reply(frame.id, { configOptions: antigravity ? [{ id: 'thought_level', category: 'thought_level', currentValue: frame.params.configId === 'thought_level' ? frame.params.value : 'medium' }] : [{ id: frame.params.configId, currentValue: frame.params.value }] });
}

async function handle(frame) {
  if (process.env.CEZ_MOCK_STDIN_FILE) appendFileSync(process.env.CEZ_MOCK_STDIN_FILE, `${recorded(frame)}\n`);
  if (process.env.CEZ_MOCK_ARGS_FILE) appendFileSync(process.env.CEZ_MOCK_ARGS_FILE, `${recorded(frame)}\n`);
  if (['session/new', 'session/resume', 'session/load'].includes(frame.method)) {
    antigravity = Boolean(frame.params._meta?.antigravity) || process.argv.includes('acp');
  }
  if (!frame.method) { pending.get(frame.id)?.(frame.result); pending.delete(frame.id); return; }
  switch (frame.method) {
    case 'initialize': reply(frame.id, { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} }, mcpCapabilities: { http: true, sse: true } }, authMethods: [{ id: 'gemini-api-key', name: 'Gemini API key' }, { id: 'oauth-personal', name: 'Google' }], agentInfo: { name: 'Antigravity ACP Server', version: '1.5.14' } }); break;
    case 'authenticate': authenticate(frame); break;
    case 'session/new':
      // Like the CLI, each session gets its own id; recordings show it as mock-acp-session.
      sessionParams = frame.params; sessionId = mintedId = `mock-acp-${randomUUID()}`; saveSession(sessionId);
      reply(frame.id, { sessionId, configOptions: [{ id: 'thought_level', category: 'thought_level', currentValue: 'medium' }] }); break;
    // A conversation the CLI does not hold (one the retired registry server saved) is refused.
    case 'session/resume': case 'session/load': if (!knownSession(frame.params.sessionId)) { write({ id: frame.id, error: { code: -32603, message: 'conversation not found' } }); break; }
      context.session.resumeAfterAsk = true; sessionParams = frame.params; sessionId = frame.params.sessionId; reply(frame.id, { configOptions: [{ id: 'thought_level', category: 'thought_level', currentValue: 'medium' }] }); break;
    case 'session/set_config_option': setConfig(frame); break;
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
