import { waitFor } from '../../core/harness-parity-core.testkit.ts';
import { withRejectedInput } from '../../core/owned-input-delivery.testkit.ts';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentEvent } from '../../core/agent-runner.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import { registerRunner } from '../../core/runner-registry.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
import { antigravityRunner } from './definition.ts';
import { pidExists } from '../../core/process-stat.ts';
import { permissionPolicy, antigravityAsk } from './permissions.ts';
import { antigravityTool } from './tool-normalization.ts';
import type { AcpPermissionRequest } from '../acp/protocol.ts';
registerRunner(antigravityRunner);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const bin = join(import.meta.dirname, '../../../scripts/mock-acp.mjs');
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'antigravity-')); dirs.push(dir); return dir; }

it('resends system instructions on resume and sets native options before prompting', async () => {
  const cwd = await workspace(); const wire = join(cwd, 'wire');
  const result = await new AntigravityRunner({ bin }).run({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'inspect the working tree',
    resume: true, sessionId: 'saved-session', systemPrompt: 'Follow these instructions', model: 'custom-model', effort: 'high',
    additionalDirectories: ['/extra'], env: { CEZ_MOCK_STDIN_FILE: wire } });
  expect(result).toMatchObject({ sessionId: 'saved-session', tokensUsed: 7 });
  const frames = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const opening = frames.find(frame => frame.method === 'session/resume').params;
  expect(opening).toMatchObject({ sessionId: 'saved-session', cwd, _meta: { antigravity: { systemPrompt: { append: 'Follow these instructions' } } } });
  expect(opening).not.toHaveProperty('additionalDirectories');
  expect(frames.filter(frame => frame.method === 'session/set_config_option').map(frame => frame.params)).toEqual([
    { sessionId: 'saved-session', configId: 'mode', value: 'default' },
    { sessionId: 'saved-session', configId: 'model', value: 'custom-model' },
    { sessionId: 'saved-session', configId: 'thinking_level', value: 'high' },
  ]);
});

it('routes a native interaction answer to its opaque option id', async () => {
  const cwd = await workspace(); const events: AgentEvent[] = [];
  const runner = new AntigravityRunner({ bin });
  const session = runner.startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:ask-native' }, event => events.push(event), {
    autoEndAfterFirstTurn: true, onUiEvent: event => {
      if (event.type === 'ask.requested') expect(session.sendMessage([{ type: 'text', text: 'Question: Vitest' }])).toBe(true);
    },
  });
  await session.result;
  expect(events).toContainEqual({ type: 'text', text: '{"outcome":{"outcome":"selected","optionId":"1"}}' });
});

it.each(['free text', 'one-option'])('refuses a native %s answer without leaving the question blocked', async variant => {
  const cwd = await workspace(); const ui: UiEvent[] = []; const events: AgentEvent[] = [];
  const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: `mock:ask-native ${variant}` }, event => events.push(event), {
    autoEndAfterFirstTurn: true, onUiEvent: event => {
      ui.push(event);
      if (event.type === 'ask.requested') expect(session.sendMessage([{ type: 'text', text: 'Question: arbitrary free text' }])).toBe(true);
    },
  });
  await session.result;
  expect(events).toContainEqual({ type: 'text', text: '{"outcome":{"outcome":"cancelled"}}' });
  expect(events).toContainEqual(expect.objectContaining({ type: 'note', message: expect.stringContaining(variant === 'free text' ? 'requires one of the offered answers' : 'requires two to four') }));
  if (variant === 'one-option') expect(ui.filter(event => event.type === 'ask.requested')).toEqual([]);
});

it.each([false, true])('loads the exact lifecycle server eagerly and calls done over its MCP bridge (resume=%s)', async resume => {
  const cwd = await workspace(); const receipt = join(cwd, 'done-called'); const wire = join(cwd, 'wire');
  const server = join(cwd, 'mcp.mjs');
  await writeFile(server, `import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
readline.createInterface({ input: process.stdin }).on('line', line => {
 const frame = JSON.parse(line); if (frame.id === undefined) return;
 let result = {};
 if (frame.method === 'initialize') result = { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
 if (frame.method === 'tools/list') result = { tools: [{ name: 'cezar_done', inputSchema: { type: 'object', properties: {} } }] };
 if (frame.method === 'tools/call') { writeFileSync(process.argv[2], frame.params.name); result = { content: [{ type: 'text', text: 'accepted' }] }; }
 console.log(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
});`);
  const name = 'cezar_ci_fixture';
  await new AntigravityRunner({ bin }).run({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:acp-eager-done',
    ...(resume ? { resume: true, sessionId: 'saved' } : {}),
    squawkTools: { name, command: process.execPath, args: [server, receipt] }, env: { CEZ_MOCK_STDIN_FILE: wire } });
  expect(await readFile(receipt, 'utf8')).toBe('cezar_done');
  const frames = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(frames.find(frame => frame.method === (resume ? 'session/resume' : 'session/new')).params._meta.antigravity.eagerMcpServers).toEqual([name]);
});

it.each([false, true])('uses the task cwd and disables native workflow skill writes (resume=%s)', async resume => {
  const cwd = await workspace(); const wire = join(cwd, 'wire'); const ui: UiEvent[] = [];
  await new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:acp-runtime-workspace',
    ...(resume ? { resume: true, sessionId: 'saved' } : {}),
    additionalDirectories: ['/repo/.ai/squawk/runs', '/repo/.ai/squawk/t/task'], env: { CEZ_MOCK_STDIN_FILE: wire } }, undefined, { autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) }).result;
  const proof = JSON.parse(await readFile(join(cwd, 'workspace-proof'), 'utf8'));
  expect(proof.sessionCwd).toBe(cwd);
  expect(proof).not.toHaveProperty('additionalDirectories');
  expect(proof.processCwd).toBe(cwd);
  const frames = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(frames.find(frame => frame.method === (resume ? 'session/resume' : 'session/new')).params._meta.antigravity.disabledTools).toEqual(['run_workflow']);
  await expect(access(join(cwd, 'skills/system/run-workflow/SKILL.md'))).rejects.toThrow();
  expect(ui.filter(event => event.type === 'session.error')).toEqual([]);
});

it.runIf(process.platform !== 'win32')('waits for native cancellation and reaps a detached foreground command after its harness exits', async () => {
  const cwd = await workspace(); const ui: UiEvent[] = []; const events: AgentEvent[] = [];
  let commandPid: number | undefined;
  const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:acp-detached-command',
    timings: { eofTermGraceMs: 1_000, eofKillGraceMs: 50 } }, event => {
    events.push(event);
    if (event.type === 'tool-call') commandPid = (event.input as { pid: number }).pid;
  }, { onUiEvent: event => ui.push(event) });
  try {
    await waitFor(() => commandPid !== undefined);
    expect(pidExists(commandPid!)).toBe(true);
    session.interrupt();
    await session.result;
    await waitFor(() => !pidExists(commandPid!));
    expect(events).toContainEqual({ type: 'tool-result', toolCallId: 'foreground', result: 'Cancelled by agent', isError: true });
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'cancelled' }));
    // oxlint-disable-next-line cez/test-enum-literal -- UI tool status is independent of run status.
    expect(ui).toContainEqual(expect.objectContaining({ type: 'item.completed', item: expect.objectContaining({ id: 'foreground', status: 'failed' }) }));
  } finally {
    session.interrupt(); await session.result.catch(() => undefined);
    if (commandPid && pidExists(commandPid)) process.kill(commandPid, 'SIGKILL');
  }
});

it('acknowledges steering without ending the active turn or showing its provider diagnostic', async () => {
  const cwd = await workspace(); const events: AgentEvent[] = []; const ui: UiEvent[] = [];
  let ack: Promise<void> | false = false;
  const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:steer-tool' }, event => {
    events.push(event);
    if (event.type === 'tool-call') ack = session.sendAgentMessage([{ type: 'text', text: 'inspect this too' }]);
  }, { autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) });
  await session.result; expect(ack).not.toBe(false); await ack;
  expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1);
  expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(1);
  expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).not.toContain('Concurrent receive_steps');
});

it('fails closed on a narrowed grant and shell composition outside a command prefix', () => {
  const request: AcpPermissionRequest = { sessionId: 'session', toolCall: { toolCallId: 'cmd', kind: 'execute', rawInput: { CommandLine: 'git status; rm -rf /tmp/probe' } },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] };
  expect(permissionPolicy({ kind: 'explicit', tools: ['Read'] }, request)).toEqual({ outcome: 'selected', optionId: 'deny' });
  expect(permissionPolicy({ kind: 'unset', bashAllowlist: ['git status'] }, request)).toEqual({ outcome: 'selected', optionId: 'deny' });
  expect(permissionPolicy({ kind: 'explicit', tools: ['Bash'], bashAllowlist: ['git status'] }, { ...request, toolCall: { ...request.toolCall, rawInput: { CommandLine: 'git status --short' } } })).toEqual({ outcome: 'selected', optionId: 'allow' });
});


it('reports native execution errors as a failed turn and a failed result', async () => {
  const cwd = await workspace(); const ui: UiEvent[] = []; const events: AgentEvent[] = [];
  const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:provider-unavailable' }, event => events.push(event), {
    autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event),
  });
  await expect(session.result).rejects.toThrow('Agent execution error:');
  expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  // S44/S18: the run consumer must see the fault before any terminal boundary.
  expect(events.filter(event => event.type === 'error' || event.type === 'turn-end').map(event => event.type))
    .toEqual(['error', 'turn-end']);
});

it('counts a late steer as a successor turn and waits for its permission and result', async () => {
  const cwd = await workspace(); const ui: UiEvent[] = [];
  let ack: Promise<void> | false = false;
  const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:acp-late-steer' }, event => {
    if (event.type === 'tool-call') ack = session.sendAgentMessage([{ type: 'text', text: 'late input' }]);
  }, { autoEndAfterFirstTurn: true, onUiEvent: event => {
    ui.push(event);
    if (event.type === 'permission.requested') expect(session.respondPermission?.(event.requestId, 'allow-once')).toBe(true);
  } });
  const result = await session.result; await ack;
  expect(result.tokensUsed).toBe(18);
  expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(2);
});

it('holds human steering after its early ACK until the carrying turn completes', async () => {
  const cwd = await workspace(); const gate = join(cwd, 'release');
  const events: AgentEvent[] = []; let ready = 0;
  const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' },
    userPrompt: 'mock:steer-tool', env: { CEZ_MOCK_STEER_GATE: gate } }, event => events.push(event),
  { autoEndAfterFirstTurn: true, onAgentInputReady: () => { ready++; } });
  try {
    await waitFor(() => events.some(event => event.type === 'tool-call'));
    ready = 0;
    expect(session.sendMessage([{ type: 'text', text: 'human steer' }])).toBe(true);
    expect(session.holdsHumanInput()).toBe(true);
    await waitFor(() => ready > 0); // The early prompt response has arrived.
    expect(session.holdsHumanInput()).toBe(true);
    expect(events.filter(event => event.type === 'turn-end')).toHaveLength(0);
    await writeFile(gate, 'release');
    await waitFor(() => events.some(event => event.type === 'turn-end'));
    expect(session.holdsHumanInput()).toBe(false);
    await session.result;
    expect(events.filter(event => event.type === 'token-usage')).toEqual([{ type: 'token-usage', tokensUsed: 7 }]);
  } finally { session.interrupt(); await session.result.catch(() => undefined); }
});

it('holds late human steering through the original turn end and releases at successor start', async () => {
  const cwd = await workspace(); const events: AgentEvent[] = [];
  const holdsAtCompletion: boolean[] = []; const holdsAtStart: boolean[] = [];
  const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' },
    userPrompt: 'mock:acp-late-steer' }, event => {
    events.push(event);
    if (event.type === 'tool-call') expect(session.sendMessage([{ type: 'text', text: 'late human steer' }])).toBe(true);
  }, { autoEndAfterFirstTurn: true, onUiEvent: event => {
    if (event.type === 'turn.completed') holdsAtCompletion.push(session.holdsHumanInput());
    if (event.type === 'turn.started') holdsAtStart.push(session.holdsHumanInput());
    if (event.type === 'permission.requested') expect(session.respondPermission?.(event.requestId, 'allow-once')).toBe(true);
  } });
  await session.result;
  expect(holdsAtCompletion).toEqual([true, false]);
  expect(holdsAtStart).toEqual([false, false]);
  expect(events.filter(event => event.type === 'turn-end')).toHaveLength(2);
});

it.each(['discard', 'close', 'reject'] as const)('releases a human hold on %s', async action => {
  await withRejectedInput('antigravity', async () => {
    const cwd = await workspace(); const events: AgentEvent[] = []; let ready = 0;
    const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' },
      userPrompt: 'mock:steer-tool', env: { CEZ_MOCK_STEER_GATE: join(cwd, 'release') } }, event => events.push(event),
    { onAgentInputReady: () => { ready++; } });
    const settled = session.result.catch(() => undefined);
    try {
      await waitFor(() => events.some(event => event.type === 'tool-call'));
      ready = 0;
      expect(session.sendMessage([{ type: 'text', text: action === 'reject' ? 'reject-owned-turn' : 'human input' }])).toBe(true);
      expect(session.holdsHumanInput()).toBe(true);
      if (action === 'discard') session.discardQueuedMessages();
      else if (action === 'close') session.end();
      else await waitFor(() => ready > 0);
      expect(session.holdsHumanInput()).toBe(false);
    } finally { session.interrupt(); await settled; }
  });
});

it('matches explicitly granted native tools outside the common alias table', () => {
  const request: AcpPermissionRequest = { sessionId: 'session',
    toolCall: { toolCallId: 'image', title: 'Run generate_image?', kind: 'other', rawInput: {} },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] };
  expect(permissionPolicy({ kind: 'explicit', tools: ['generate_image'] }, request)).toEqual({ outcome: 'selected', optionId: 'allow' });
  expect(permissionPolicy({ kind: 'explicit', tools: ['Read'] }, request)).toEqual({ outcome: 'selected', optionId: 'deny' });
});

it('maps distinct shortened native ask labels back to their opaque option IDs', () => {
  const prefix = 'A'.repeat(70);
  const ask = antigravityAsk({ sessionId: 'session', toolCall: { toolCallId: 'interaction_long', title: 'Choose' },
    options: [{ optionId: 'red', name: `${prefix} red`, kind: 'allow_once' }, { optionId: 'blue', name: `${prefix} blue`, kind: 'allow_once' }] })!;
  if ('refused' in ask) throw new Error(ask.refused);
  const labels = ask.questions[0]!.options!.map(option => option.label);
  expect(new Set(labels).size).toBe(2);
  expect(labels.every(label => label.length <= 60)).toBe(true);
  expect(ask.answer(`Question: ${labels[0]}`)).toEqual({ outcome: { outcome: 'selected', optionId: 'red' } });
  expect(ask.answer(`Question: ${labels[1]}`)).toEqual({ outcome: { outcome: 'selected', optionId: 'blue' } });
});

it.each(['Read', 'Bash'])('requires a server-qualified grant for an MCP tool named %s', name => {
  const request: AcpPermissionRequest = { sessionId: 'session',
    toolCall: { toolCallId: 'external-call', title: `external_${name}`, kind: 'execute', rawInput: {},
      _meta: { mcp: { server: 'external', tool: name } } },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] };
  expect(antigravityTool(request.toolCall)).toMatchObject({ name, title: name });
  expect(permissionPolicy({ kind: 'explicit', tools: [name] }, request)).toEqual({ outcome: 'selected', optionId: 'deny' });
  expect(permissionPolicy({ kind: 'explicit', tools: [`other_${name}`] }, request)).toEqual({ outcome: 'selected', optionId: 'deny' });
  expect(permissionPolicy({ kind: 'explicit', tools: [`external_${name}`], bashAllowlist: ['git status'] }, request)).toEqual({ outcome: 'selected', optionId: 'allow' });
  expect(permissionPolicy({ kind: 'inherited', tools: [`mcp__external__${name}`] }, request)).toEqual({ outcome: 'selected', optionId: 'allow' });
});
