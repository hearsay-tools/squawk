import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../core/agent-runner.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import { AcpSession, type AcpSessionOptions } from './session.ts';

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
    expect(ui).toContainEqual(expect.objectContaining({ type: 'item.updated', item: expect.objectContaining({ id: 'extended-tool', toolKind: 'other', status: 'running' }) }));
    // oxlint-disable-next-line cez/test-enum-literal -- ACP plan status has its own vocabulary.
    expect(ui).toContainEqual({ type: 'plan.updated', entries: [{ content: 'Vendor plan', status: 'pending', priority: 'high' }] });
    expect(ui.filter(event => event.type === 'session.error' && !event.fatal)).toHaveLength(9);
    expect(events.filter(event => event.type === 'note')).toHaveLength(9);
    expect(ui).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'end_turn' }));
    await expect(session.prompt([{ type: 'text', text: 'mock:agent-echo follow-up' }])).resolves.toMatchObject({ stopReason: 'end_turn' });
  });

  it('initializes, authenticates and maps a full turn, including early usage, tools and follow-ups', async () => {
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
    expect(events.slice(0, 2)).toEqual([{ type: 'session', sessionId: 'mock-acp-session', resumed: false }, { type: 'token-usage', tokensUsed: 0 }]);
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
    expect(frames.find(frame => frame.method === 'authenticate').params).toEqual({ methodId: 'mock-key' });
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
