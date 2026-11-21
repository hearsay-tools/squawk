import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AgentEvent } from '../../core/agent-runner.ts';
import type { UiEvent } from '../../core/ui-events.ts';
import { registerRunner } from '../../core/runner-registry.ts';
import { AntigravityRunner } from './antigravity-runner.ts';
import { antigravityRunner } from './definition.ts';
import { permissionPolicy } from './permissions.ts';
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
  expect(frames.find(frame => frame.method === 'session/resume').params).toMatchObject({ sessionId: 'saved-session', additionalDirectories: ['/extra'], _meta: { antigravity: { systemPrompt: { append: 'Follow these instructions' } } } });
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
