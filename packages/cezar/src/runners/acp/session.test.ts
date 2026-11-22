import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { waitFor } from '../../core/harness-parity-core.testkit.ts';
import type { AgentEvent } from '../../core/agent-runner.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import { AcpSession, type AcpSessionOptions } from './session.ts';
import { createDeliveryControl } from '../../../scripts/mock-delivery-control.mjs';

const children: ChildProcessWithoutNullStreams[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
function start(options: Partial<AcpSessionOptions> = {}, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [join(import.meta.dirname, '../../../scripts/mock-acp.mjs')], { stdio: 'pipe', env: { ...process.env, ...env } });
  children.push(child);
  const events: AgentEvent[] = [];
  const ui: UiEvent[] = [];
  const session = new AcpSession({ input: child.stdin, output: child.stdout }, {
    backend: 'fixture-acp', clientInfo: { name: 'squawk-test', version: '1' },
    ...options, event: event => { events.push(event); options.event?.(event); },
    uiEvent: event => { ui.push(event); options.uiEvent?.(event); },
  });
  return { session, events, ui };
}

describe('shared ACP session over the native mock wire', () => {
  it('keeps a prompt alive across malformed and extended updates, with one diagnostic per update', async () => {
    const { session, events, ui } = start();
    await session.initialize(); await session.open({ cwd: tmpdir() });
    await expect(session.prompt([{ type: 'text', text: 'mock:acp-extended-updates' }])).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(events).toContainEqual({ type: 'text', text: 'before extensions' });
    expect(events).toContainEqual({ type: 'tool-result', toolCallId: 'extended-tool', result: 'extension survived', isError: false });
    // oxlint-disable-next-line cez/test-enum-literal -- UI tool status has its own vocabulary.
    expect(ui).toContainEqual(expect.objectContaining({ type: 'item.updated', item: expect.objectContaining({ id: 'extended-tool', toolKind: 'other', status: 'running' }) }));
    // oxlint-disable-next-line cez/test-enum-literal -- ACP plan status has its own vocabulary.
    expect(ui).toContainEqual({ type: 'plan.updated', entries: [{ content: 'Vendor plan', status: 'pending', priority: 'high' }] });
    expect(ui.filter(event => event.type === 'session.error' && !event.fatal)).toHaveLength(9);
    expect(events.filter(event => event.type === 'note')).toHaveLength(9);
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'end_turn' }));
    await expect(session.prompt([{ type: 'text', text: 'mock:agent-echo follow-up' }])).resolves.toMatchObject({ stopReason: 'end_turn' });
  });

  it('initializes, authenticates and maps a full turn, including tools and follow-ups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'squawk-acp-')); dirs.push(dir);
    const wire = join(dir, 'wire.ndjson');
    const options: unknown[] = [];
    const { session, events, ui } = start({ hooks: {
      selectAuthMethod: hello => hello.authMethods[0]!.id,
      sessionParams: () => ({ _meta: { fixture: { systemPrompt: { append: 'Test instruction' } } } }),
      normalizeTool: () => ({ name: 'Read', toolKind: 'read' }),
      normalizeOptions: value => options.push(value),
    } }, { CEZ_MOCK_STDIN_FILE: wire });
    await session.initialize();
    await session.open({ cwd: dir });
    expect(events[0]).toEqual({ type: 'session', sessionId: expect.stringMatching(/^mock-acp-/), resumed: false });
    expect(await session.prompt([{ type: 'text', text: 'Inspect the repo' }])).toMatchObject({ stopReason: 'end_turn' });
    expect(events).toContainEqual({ type: 'tool-call', id: 'read-1', tool: 'Read', input: { path: 'README.md' } });
    expect(events).toContainEqual({ type: 'tool-result', toolCallId: 'read-1', result: 'mock file', isError: false });
    expect(ui).toContainEqual(expect.objectContaining({ type: 'item.completed', item: expect.objectContaining({ name: 'Read', status: 'completed' }) }));
    await session.prompt([{ type: 'text', text: 'mock:agent-echo follow-up' }]);
    expect(events).toContainEqual({ type: 'text', text: 'mock:agent-echo follow-up' });
    expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(2);
    await session.setConfigOption('model', 'fixture-model');
    expect(options.at(-1)).toEqual([{ id: 'model', currentValue: 'fixture-model' }]);
    const frames = (await readFile(wire, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(frames.find(frame => frame.method === 'initialize').params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } });
    expect(frames.find(frame => frame.method === 'authenticate').params).toEqual({ methodId: 'gemini-api-key' });
    expect(frames.find(frame => frame.method === 'session/new').params._meta).toEqual({ fixture: { systemPrompt: { append: 'Test instruction' } } });
  });

  it('resumes without replay and answers a native permission through opaque option IDs', async () => {
    const { session, events, ui } = start({ uiEvent: event => {
      if (event.type === 'permission.requested') {
        expect(session.respondPermission(event.requestId, 'invented')).toBe(false);
        expect(session.respondPermission(event.requestId, 'allow-once')).toBe(true);
        expect(session.respondPermission(event.requestId, 'allow-once')).toBe(false);
      }
    } });
    await session.initialize();
    await session.open({ cwd: tmpdir(), sessionId: 'saved-session' });
    expect(events).toContainEqual({ type: 'session', sessionId: 'saved-session', resumed: true });
    await session.prompt([{ type: 'text', text: 'mock:acp-permission' }]);
    expect(events).toContainEqual({ type: 'text', text: '{"outcome":{"outcome":"selected","optionId":"allow-once"}}' });
    expect(ui).toContainEqual(expect.objectContaining({ type: 'permission.resolved', optionId: 'allow-once' }));
  });

  it('cancels a turn and all pending permissions, then permits a new turn', async () => {
    const { session, ui } = start({ uiEvent: event => { if (event.type === 'permission.requested') session.cancel(); } });
    await session.initialize(); await session.open({ cwd: tmpdir() });
    expect(await session.prompt([{ type: 'text', text: 'mock:acp-permission' }])).toMatchObject({ stopReason: 'cancelled' });
    expect(ui).toContainEqual(expect.objectContaining({ type: 'permission.resolved', reason: 'cancelled' }));
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'cancelled' }));
    expect(await session.prompt([{ type: 'text', text: 'mock:agent-echo after cancel' }])).toMatchObject({ stopReason: 'end_turn' });
  });

  it('cancels permission requests that arrive after cancel, and resets cancellation for a new prompt', async () => {
    const { session, ui } = start({ uiEvent: event => {
      if (event.type === 'permission.requested') session.respondPermission(event.requestId, 'allow-once');
    } });
    await session.initialize(); await session.open({ cwd: tmpdir() });
    const prompt = session.prompt([{ type: 'text', text: 'mock:acp-permission' }]);
    session.cancel();
    await expect(prompt).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(ui.filter(event => event.type === 'permission.requested')).toHaveLength(0);
    await expect(session.prompt([{ type: 'text', text: 'mock:acp-permission' }])).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(ui.filter(event => event.type === 'permission.requested')).toHaveLength(1);
  });

  it('keeps permission card IDs within the contract bound when native RPC IDs are long', async () => {
    const { session, events } = start({ uiEvent: event => {
      if (event.type !== 'permission.requested') return;
      expect(event.requestId.length).toBeLessThanOrEqual(128);
      expect(session.respondPermission(event.requestId, 'allow-once')).toBe(true);
    } });
    await session.initialize(); await session.open({ cwd: tmpdir() });
    await expect(session.prompt([{ type: 'text', text: 'mock:acp-permission long-id' }])).resolves.toMatchObject({ stopReason: 'end_turn' });
    expect(events).toContainEqual({ type: 'text', text: '{"outcome":{"outcome":"selected","optionId":"allow-once"}}' });
  });

  it('uses runner hooks to expose a permission as a native ask and encode its answer', async () => {
    const { session, events, ui } = start({ hooks: { permissionAsk: () => ({
      questions: [{ header: 'Choice', question: 'Continue?' }],
      answer: value => ({ outcome: { outcome: 'selected', optionId: value === 'Yes' ? 'allow-once' : 'reject-once' } }),
    }) }, uiEvent: event => { if (event.type === 'ask.requested') expect(session.respondAsk(event.requestId, 'Yes')).toBe(true); } });
    await session.initialize(); await session.open({ cwd: tmpdir() });
    await session.prompt([{ type: 'text', text: 'mock:acp-ask' }]);
    expect(ui).toContainEqual(expect.objectContaining({ type: 'ask.requested', questions: [{ header: 'Choice', question: 'Continue?' }] }));
    expect(events).toContainEqual({ type: 'text', text: '{"outcome":{"outcome":"selected","optionId":"allow-once"}}' });
  });
});


it('keeps one logical turn when a steer ends the running prompt first, and sums the usage', async () => {
  let steer: Promise<void> | undefined;
  const { session, ui } = start({ hooks: { normalizeUsage: () => ({ input: 3, output: 4, total: 7 }) }, event: event => {
    if (event.type === 'tool-call' && !steer) steer = session.steer([{ type: 'text', text: 'steered input' }]);
  } });
  await session.initialize(); await session.open({ cwd: tmpdir() });
  await session.prompt([{ type: 'text', text: 'mock:steer-tool' }]);
  expect(steer).toBeDefined(); await steer;
  expect(ui.filter(event => event.type === 'turn.started')).toHaveLength(1);
  // The early-ended prompt reports no usage on the CLI; the mock's reports both, summed into one turn.
  expect(ui.filter(event => event.type === 'turn.completed')).toEqual([expect.objectContaining({ stopReason: 'end_turn' })]);
});

it('maps work after the turn to an agent-started turn that asks and ends on its own', async () => {
  const { session, ui, events } = start({ hooks: {
    agentWorkEnds: (update, previous) => update.sessionUpdate === 'usage_update' && previous === 'agent_message_chunk',
  }, uiEvent: event => {
    if (event.type === 'permission.requested') expect(session.respondPermission(event.requestId, 'allow-once')).toBe(true);
  } });
  await session.initialize(); await session.open({ cwd: tmpdir() });
  await session.prompt([{ type: 'text', text: 'mock:permission-late' }]);
  await waitFor(() => ui.filter(event => event.type === 'turn.completed').length === 2);
  expect(ui.filter(event => event.type === 'turn.started')).toHaveLength(2);
  expect(session.agentWorking).toBe(false);
  expect(ui).toContainEqual(expect.objectContaining({ type: 'permission.resolved', optionId: 'allow-once' }));
  expect(events).toContainEqual({ type: 'text', text: expect.stringMatching(/^Approval response: \{"reply":"once"\}/) });
});

it('lets a prompt carry an open agent-started turn instead of starting a second one', async () => {
  const { session, ui, events } = start({ hooks: { agentWorkEnds: () => false, permissionPolicy: () => ({ outcome: 'selected', optionId: 'allow-once' }) } });
  await session.initialize(); await session.open({ cwd: tmpdir() });
  await session.prompt([{ type: 'text', text: 'mock:permission-late' }]);
  await waitFor(() => events.some(event => event.type === 'text' && event.text.startsWith('Approval response: {"reply":"once"}')));
  expect(session.agentWorking).toBe(true);
  await session.prompt([{ type: 'text', text: 'mock:agent-echo joined' }]);
  expect(ui.filter(event => event.type === 'turn.started')).toHaveLength(2);
  expect(ui.filter(event => event.type === 'turn.completed')).toHaveLength(2);
  expect(session.agentWorking).toBe(false);
});

it('applies update filtering and provider usage to a prompt without mutating mapper state', async () => {
  const { session, events, ui } = start({ hooks: {
    filterUpdate: update => update.sessionUpdate !== 'agent_message_chunk',
    normalizeUsage: () => ({ input: 3, output: 4, total: 7 }),
  } });
  await session.initialize(); await session.open({ cwd: tmpdir() });
  await session.prompt([{ type: 'text', text: 'a filtered message' }]);
  expect(events.filter(event => event.type === 'text')).toEqual([]);
  expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', usage: { input: 3, output: 4, total: 7 } }));
});

/** The mock plays a matching prompt's frames, then holds its response until release. */
async function heldResponse(match: string) {
  const dir = await mkdtemp(join(tmpdir(), 'squawk-acp-ack-')); dirs.push(dir);
  const control = createDeliveryControl(dir, { kind: 'hold-ack', match });
  return { control, env: { CEZ_MOCK_DELIVERY_CONTROL: control.path } };
}

describe('acknowledging a prompt that opens a turn', () => {
  it('acknowledges at the turn\'s first agent work, while its response is still held', async () => {
    const { control, env } = await heldResponse('first-work');
    const { session, events, ui } = start({}, env);
    await session.initialize(); await session.open({ cwd: tmpdir() });
    let acknowledged = false;
    const response = session.prompt([{ type: 'text', text: 'Inspect first-work' }], () => { acknowledged = true; });
    await waitFor(() => control.held());
    expect(events).toContainEqual({ type: 'text', text: expect.stringContaining('Inspect first-work') });
    expect(acknowledged).toBe(true);
    expect(ui.filter(event => event.type === 'turn.completed')).toEqual([]);
    control.release();
    await expect(response).resolves.toMatchObject({ stopReason: 'end_turn' });
  });

  it('acknowledges a turn with no agent work only after its response ends the turn', async () => {
    const { session, ui } = start();
    await session.initialize(); await session.open({ cwd: await mkdtemp(join(tmpdir(), 'squawk-acp-quiet-')).then(dir => { dirs.push(dir); return dir; }) });
    let completedAtAcknowledgement: number | undefined;
    await session.prompt([{ type: 'text', text: 'mock:acp-runtime-workspace' }], () => { completedAtAcknowledgement = ui.filter(event => event.type === 'turn.completed').length; });
    expect(completedAtAcknowledgement).toBe(1);
  });

  it('never acknowledges a prompt whose turn reported a provider failure first', async () => {
    const { session } = start({ hooks: { updateError: update => update.sessionUpdate === 'agent_message_chunk' ? 'provider failed' : undefined } });
    await session.initialize(); await session.open({ cwd: tmpdir() });
    let acknowledged = false;
    await expect(session.prompt([{ type: 'text', text: 'Inspect the repo' }], () => { acknowledged = true; })).rejects.toThrow('provider failed');
    expect(acknowledged).toBe(false);
  });

  it('acknowledges a prompt that joins an agent-started turn only at its response', async () => {
    const { control, env } = await heldResponse('joined');
    const { session, events } = start({ hooks: { agentWorkEnds: () => false, permissionPolicy: () => ({ outcome: 'selected', optionId: 'allow-once' }) } }, env);
    await session.initialize(); await session.open({ cwd: tmpdir() });
    await session.prompt([{ type: 'text', text: 'mock:permission-late' }]);
    await waitFor(() => session.agentWorking);
    let acknowledged = false;
    const response = session.prompt([{ type: 'text', text: 'mock:agent-echo joined' }], () => { acknowledged = true; });
    await waitFor(() => control.held());
    expect(events).toContainEqual({ type: 'text', text: expect.stringContaining('joined') });
    expect(acknowledged).toBe(false);
    control.release();
    await response;
    expect(acknowledged).toBe(true);
  });
});
