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
import { permissionPolicy } from './permissions.ts';
import { antigravityTool } from './tool-normalization.ts';
import type { AcpPermissionRequest } from '../acp/protocol.ts';
registerRunner(antigravityRunner);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const bin = join(import.meta.dirname, '../../../scripts/mock-acp.mjs');
async function workspace() { const dir = await mkdtemp(join(tmpdir(), 'antigravity-')); dirs.push(dir); return dir; }

it('saves system instructions on session/new, prepends them to a resumed opening turn and sets native options first', async () => {
  const cwd = await workspace(); const wire = join(cwd, 'wire');
  const result = await new AntigravityRunner({ bin }).run({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'inspect the working tree',
    resume: true, sessionId: 'saved-session', systemPrompt: 'Follow these instructions', model: 'custom-model', effort: 'high',
    additionalDirectories: ['/extra'], env: { CEZ_MOCK_STDIN_FILE: wire } });
  expect(result).toMatchObject({ sessionId: 'saved-session', tokensUsed: 7 });
  const frames = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const opening = frames.find(frame => frame.method === 'session/resume').params;
  // The CLI saved the session/new prompt with the session; a resent _meta one would be appended twice.
  expect(opening).toEqual({ sessionId: 'saved-session', cwd, mcpServers: [] });
  // In the thread instead: prepended to the resumed opening turn, as Codex and OpenCode do.
  expect(frames.find(frame => frame.method === 'session/prompt').params.prompt).toEqual([{ type: 'text', text: 'Follow these instructions\n\n---\n\ninspect the working tree' }]);
  expect(frames.filter(frame => frame.method === 'session/set_config_option').map(frame => frame.params)).toEqual([
    { sessionId: 'saved-session', configId: 'mode', value: 'default' },
    { sessionId: 'saved-session', configId: 'model', value: 'custom-model' },
    { sessionId: 'saved-session', configId: 'thought_level', value: 'high' },
  ]);
  const fresh = join(cwd, 'fresh');
  await new AntigravityRunner({ bin }).run({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'inspect', systemPrompt: 'Follow these instructions', env: { CEZ_MOCK_STDIN_FILE: fresh } });
  const created = (await readFile(fresh, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(frame => frame.method === 'session/new').params;
  expect(created._meta).toEqual({ antigravity: { systemPrompt: { append: 'Follow these instructions' } } });
});

it('launches the CLI ACP server on the account folder with per-account file token storage', async () => {
  const cwd = await workspace(); const account = join(cwd, 'account');
  const result = await new AntigravityRunner({ bin }).run({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:account-homes', env: { GEMINI_HOME: account } });
  expect(JSON.parse(result.text)).toMatchObject({ gemini: account, appData: 'antigravity-cli', ssh: '127.0.0.1 0 127.0.0.1 0' });
  expect(JSON.parse(result.text)).not.toHaveProperty('geminiHome');
});

it('shows ask_question as a card and sends the chosen answer as the next prompt', async () => {
  const cwd = await workspace(); const events: AgentEvent[] = []; const asks: UiEvent[] = []; const wire = join(cwd, 'wire');
  const runner = new AntigravityRunner({ bin });
  const session = runner.startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:ask-native', env: { CEZ_MOCK_STDIN_FILE: wire } }, event => events.push(event), {
    autoEndAfterFirstTurn: true, onUiEvent: event => {
      if (event.type !== 'ask.requested') return;
      asks.push(event);
      expect(session.sendAgentMessage([{ type: 'text', text: 'nudge' }])).toBe(false);
      expect(session.sendMessage([{ type: 'text', text: 'Question: Vitest' }])).toBe(true);
    },
  });
  await session.result;
  expect(asks).toEqual([{ type: 'ask.requested', requestId: 'antigravity-ask-call_ask_question', questions: [{ header: 'Question', question: 'Which test library?',
    options: [{ label: 'Vitest', description: 'Recommended' }, { label: 'Node test' }] }] }]);
  const prompts = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(frame => frame.method === 'session/prompt');
  expect(prompts.at(-1).params.prompt).toEqual([{ type: 'text', text: 'Vitest' }]);
  expect(events).toContainEqual({ type: 'text', text: 'Answer received: Vitest' });
});

it('shows no card for a malformed ask_question and still ends the turn', async () => {
  const cwd = await workspace(); const ui: UiEvent[] = [];
  await new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:ask-bad' }, undefined, {
    autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) }).result;
  expect(ui.filter(event => event.type === 'ask.requested')).toEqual([]);
  expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(1);
});

it.each([false, true].flatMap(resume => ['mock-no-thinking', 'mock-low-thinking'].map(model => ({ resume, model }))))('ignores an effort absent from $model options and completes (resume=$resume)', async ({ resume, model }) => {
  const cwd = await workspace(); const wire = join(cwd, 'wire'); const events: AgentEvent[] = [];
  const result = await new AntigravityRunner({ bin }).run({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'inspect the working tree',
    model, effort: 'high', ...(resume ? { resume: true, sessionId: 'saved' } : {}), env: { CEZ_MOCK_STDIN_FILE: wire } }, event => events.push(event));
  expect(result.text).not.toBe('');
  expect(events).toContainEqual({ type: 'note', message: `Antigravity model ${model} ${model === 'mock-no-thinking' ? 'has no effort setting' : 'does not offer effort high'}; ignoring requested effort high.` });
  expect(events.some(event => event.type === 'error')).toBe(false);
  const frames = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(frames.some(frame => frame.method === 'session/prompt')).toBe(true);
  expect(frames.some(frame => frame.params?.configId === 'thought_level')).toBe(false);
});

it('keeps the model failure visible', async () => {
  const cwd = await workspace();
  await expect(new AntigravityRunner({ bin }).run({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'inspect', model: 'mock-invalid-model' }))
    .rejects.toThrow(/^Requested model is unavailable: Antigravity exited code 0/);
});

it.each([false, true])('calls done over the squawk MCP bridge (resume=%s)', async resume => {
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
  expect(frames.find(frame => frame.method === (resume ? 'session/resume' : 'session/new')).params.mcpServers).toEqual([expect.objectContaining({ type: 'http', name: 'squawk' })]);
});

it.each([false, true])('uses the task cwd and writes no native skill into it (resume=%s)', async resume => {
  const cwd = await workspace(); const wire = join(cwd, 'wire'); const ui: UiEvent[] = [];
  await new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:acp-runtime-workspace',
    ...(resume ? { resume: true, sessionId: 'saved' } : {}),
    additionalDirectories: ['/repo/.ai/squawk/runs', '/repo/.ai/squawk/t/task'], env: { CEZ_MOCK_STDIN_FILE: wire } }, undefined, { autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) }).result;
  const proof = JSON.parse(await readFile(join(cwd, 'workspace-proof'), 'utf8'));
  expect(proof.sessionCwd).toBe(cwd);
  expect(proof).not.toHaveProperty('additionalDirectories');
  expect(proof.processCwd).toBe(cwd);
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

it('keeps one logical turn when a steer ends the running prompt first, and sums its usage', async () => {
  const cwd = await workspace(); const events: AgentEvent[] = []; const ui: UiEvent[] = [];
  let ack: Promise<void> | false = false;
  const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:steer-tool' }, event => {
    events.push(event);
    if (event.type === 'tool-call') ack = session.sendAgentMessage([{ type: 'text', text: 'inspect this too' }]);
  }, { autoEndAfterFirstTurn: true, onUiEvent: event => ui.push(event) });
  await session.result; expect(ack).not.toBe(false); await ack;
  expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1);
  expect(ui.filter(event => event.type === 'turn.started')).toHaveLength(1);
  expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(1);
  expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain('saw: inspect this too');
  const tools = ui.filter(event => event.type === 'item.completed' && event.item.kind === 'tool').map(event => event.type === 'item.completed' ? event.item.id : '');
  expect(new Set(tools).size).toBe(tools.length);
});

it('maps work after the turn to an agent-started turn and closes quietly once it ends', async () => {
  const cwd = await workspace(); const ui: UiEvent[] = []; const events: AgentEvent[] = [];
  const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' }, userPrompt: 'mock:permission-late' }, event => {
    events.push(event);
    if (event.type === 'turn-end' && events.filter(item => item.type === 'turn-end').length === 1) session.endWhenQuiet!();
  }, { onUiEvent: event => {
    ui.push(event);
    if (event.type === 'permission.requested') expect(session.respondPermission?.(event.requestId, 'allow-once')).toBe(true);
  } });
  await waitFor(() => session.closingQuietly === true || !session.open);
  expect(session.open).toBe(false);
  await session.result;
  expect(ui.filter(event => event.type === 'turn.started')).toHaveLength(2);
  expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(2);
  const second = ui.findLastIndex(event => event.type === 'turn.started');
  expect(ui.findIndex(event => event.type === 'permission.requested')).toBeGreaterThan(second);
  expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain('Approval response: {"reply":"once"}');
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
  await expect(session.result).rejects.toThrow('⚠ agent executor error:');
  expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }));
  expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
  // S44/S18: the run consumer must see the fault before any terminal boundary.
  expect(events.filter(event => event.type === 'error' || event.type === 'turn-end').map(event => event.type))
    .toEqual(['error', 'turn-end']);
});

it('holds a steered human message until the response that ends its turn', async () => {
  const cwd = await workspace(); const gate = join(cwd, 'release'); const events: AgentEvent[] = [];
  const session = new AntigravityRunner({ bin }).startSession({ cwd, toolGrant: { kind: 'unset' },
    userPrompt: 'mock:steer-tool', env: { CEZ_MOCK_STEER_GATE: gate } }, event => events.push(event), { autoEndAfterFirstTurn: true });
  try {
    await waitFor(() => events.some(event => event.type === 'tool-call'));
    expect(session.sendMessage([{ type: 'text', text: 'human steer' }])).toBe(true);
    expect(session.holdsHumanInput()).toBe(true);
    await writeFile(gate, 'release');
    await waitFor(() => events.some(event => event.type === 'turn-end'));
    expect(session.holdsHumanInput()).toBe(false);
    await session.result;
    expect(events.filter(event => event.type === 'turn-end')).toHaveLength(1);
  } finally { session.interrupt(); await session.result.catch(() => undefined); }
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

it.each(['Read', 'Bash'])('requires a server-qualified grant for an MCP tool named %s', name => {
  const request: AcpPermissionRequest = { sessionId: 'session',
    toolCall: { toolCallId: 'external-call', name: `mcp_external_${name}`, title: `Run mcp_external_${name}`, kind: 'execute', rawInput: {} },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] };
  expect(antigravityTool(request.toolCall)).toMatchObject({ name, title: name });
  expect(permissionPolicy({ kind: 'explicit', tools: [name] }, request)).toEqual({ outcome: 'selected', optionId: 'deny' });
  expect(permissionPolicy({ kind: 'explicit', tools: [`other_${name}`] }, request)).toEqual({ outcome: 'selected', optionId: 'deny' });
  expect(permissionPolicy({ kind: 'explicit', tools: [`external_${name}`], bashAllowlist: ['git status'] }, request)).toEqual({ outcome: 'selected', optionId: 'allow' });
  expect(permissionPolicy({ kind: 'inherited', tools: [`mcp__external__${name}`] }, request)).toEqual({ outcome: 'selected', optionId: 'allow' });
});

it('never lets an MCP grant authorize a colliding native shell name', () => {
  const request: AcpPermissionRequest = { sessionId: 'session',
    toolCall: { toolCallId: 'cmd', title: 'run_command', kind: 'execute', rawInput: { CommandLine: 'git status' } },
    options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] };
  expect(permissionPolicy({ kind: 'explicit', tools: ['mcp__run__command'] }, request)).toEqual({ outcome: 'selected', optionId: 'deny' });
  for (const name of ['run_command', 'Bash']) {
    expect(permissionPolicy({ kind: 'explicit', tools: [name] }, request)).toEqual({ outcome: 'selected', optionId: 'allow' });
  }
});

it('trusts the Squawk server tools by their qualified CLI name', () => {
  const request: AcpPermissionRequest = { sessionId: 'session',
    toolCall: { toolCallId: 'call_1', name: 'mcp_squawk_cezar_done', title: 'Run mcp_squawk_cezar_done', kind: 'other', rawInput: {} },
    options: [{ optionId: 'allow', name: 'allow', kind: 'allow_once' }, { optionId: 'deny', name: 'deny', kind: 'reject_once' }] };
  expect(antigravityTool(request.toolCall)).toMatchObject({ name: 'cezar_done', title: 'cezar_done' });
  expect(permissionPolicy({ kind: 'explicit', tools: ['Read'] }, request, false, ['squawk_cezar_done'])).toEqual({ outcome: 'selected', optionId: 'allow' });
  expect(permissionPolicy({ kind: 'explicit', tools: ['Read'] }, request, false, ['squawk_cezar_wait'])).toEqual({ outcome: 'selected', optionId: 'deny' });
});

it('reads the native timer delay for the schedule tool', () => {
  expect(antigravityTool({ toolCallId: 'call_2', name: 'schedule', title: 'Run schedule', kind: 'other', rawInput: { DurationSeconds: 20, Prompt: 'wake' } }))
    .toMatchObject({ input: { delaySeconds: 20, prompt: 'wake' } });
});
