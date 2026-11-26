import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UiEvent, UiToolItem } from '../../core/ui-events.ts';
import { AcpEvents } from './acp/events.ts';
import {
  AntigravitySubagentTracker,
  parseChildMessageDelivery,
  parseChildToolCallId,
  parseSpawnedSubagentId,
} from './subagent-tracker.ts';
import { AntigravityChildTranscripts, mapChildTranscriptRow } from './subagent-transcript.ts';
import { antigravityWireHooks } from './wire-updates.ts';

const fixtures = new URL('./__fixtures__/', import.meta.url);
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('Antigravity subagent tracking and child transcripts', () => {
  it('parses child wire IDs, spawned conversation IDs and parent delivery messages', () => {
    const uuid = '7bb3c467-2cb1-4fdc-a962-db063faac0e6';
    expect(parseChildToolCallId(`${uuid}:call_123`)).toEqual({ childId: uuid, rawCallId: 'call_123' });
    expect(parseChildToolCallId('call_123')).toBeUndefined();
    expect(parseSpawnedSubagentId(`Created the following subagent:\n{\n  "conversationId": "${uuid}"\n}`)).toBe(uuid);
    expect(parseSpawnedSubagentId('no id here')).toBeUndefined();
    expect(parseChildMessageDelivery(`<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-26T22:30:38Z sender=${uuid} priority=MESSAGE_PRIORITY_HIGH content=done ok\n</SYSTEM_MESSAGE>`))
      .toEqual({ childId: uuid, body: 'done ok' });
  });

  it('waits for explicit binding across parallel spawns, keeps running across child messages, and settles on kill or turn end', () => {
    const tracker = new AntigravitySubagentTracker();
    const spawn = (id: string) => ({
      update: { sessionUpdate: 'tool_call_update', toolCallId: id, name: 'invoke_subagent', status: 'completed' },
      item: { kind: 'tool' as const, id, name: 'Task', toolKind: 'task' as const, title: 'Task: Worker', status: 'completed' as const },
    });
    const first = spawn('call_1');
    const second = spawn('call_2');
    expect(tracker.shouldHold(first.update, first.item)).toBe(true);
    expect(tracker.shouldHold(second.update, second.item)).toBe(true);
    const childA = '11111111-1111-4111-8111-111111111111';
    const childB = '22222222-2222-4222-8222-222222222222';
    // Parallel unbound spawns never guess FIFO when child B reports first.
    expect(tracker.parentForChild(childB)).toBeUndefined();
    // Explicit binding pins child B; now only one unbound spawn remains for child A.
    tracker.bindChild('call_2', childB);
    expect(tracker.parentForChild(childB)).toBe('call_2');
    expect(tracker.parentForChild(childA)).toBe('call_1');
    // Progress messages record latest output without closing the active subagent.
    expect(tracker.recordChildMessage(childB, 'halfway done')).toBe('call_2');
    expect(tracker.isActive('call_2')).toBe(true);
    expect(tracker.recordChildMessage(childB, 'all done')).toBe('call_2');
    expect(tracker.isActive('call_2')).toBe(true);
    // Forking does not mutate the parent tracker.
    const forked = tracker.fork();
    expect(forked.settleOnTurnEnd('cancelled')).toEqual([
      // oxlint-disable-next-line cez/test-enum-literal -- UI tool status is independent of run status.
      { id: 'call_1', status: 'failed' },
      // oxlint-disable-next-line cez/test-enum-literal -- UI tool status is independent of run status.
      { id: 'call_2', status: 'failed', output: 'all done' },
    ]);
    expect(tracker.isActive('call_1')).toBe(true);
    // manage_subagents kill settles only the targeted child.
    const killUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'call_kill', name: 'manage_subagents', status: 'completed', rawInput: { Action: 'kill', ConversationIds: [childA] } };
    expect(tracker.afterToolUpdate(killUpdate, { kind: 'tool', id: 'call_kill', name: 'manage_subagents', toolKind: 'other', title: 'Run manage_subagents', status: 'completed' }))
      .toEqual([{ id: 'call_1', status: 'declined', output: 'Stopped by parent' }]);
    // Turn end settles the remaining child with its latest recorded message.
    // oxlint-disable-next-line cez/test-enum-literal -- UI tool status is independent of run status.
    expect(tracker.settleOnTurnEnd('end_turn')).toEqual([{ id: 'call_2', status: 'completed', output: 'all done' }]);
  });

  it('repairs parentItemId on early parallel child tools once bindChild resolves', () => {
    const tracker = new AntigravitySubagentTracker();
    const ui: UiEvent[] = [];
    const events = new AcpEvents({ uiEvent: event => ui.push(event) }, antigravityWireHooks(tracker));
    events.begin();
    for (const [id, role] of [['call_a', 'First'], ['call_b', 'Second']] as const) {
      const args = { TypeName: 'self', Role: role, Prompt: 'Work' };
      events.update({ sessionUpdate: 'tool_call', toolCallId: id, name: 'invoke_subagent', kind: 'other', title: 'Run invoke_subagent', status: 'in_progress', rawInput: args });
      events.update({ sessionUpdate: 'tool_call_update', toolCallId: id, name: 'invoke_subagent', kind: 'other', title: 'Run invoke_subagent', status: 'completed', rawInput: args });
    }
    const childB = '22222222-2222-4222-8222-222222222222';
    const childCallId = `${childB}:call_cmd`;
    events.update({ sessionUpdate: 'tool_call', toolCallId: childCallId, name: 'run_command', kind: 'execute', title: 'echo b', status: 'in_progress', rawInput: { CommandLine: 'echo b' } });
    events.update({ sessionUpdate: 'tool_call_update', toolCallId: childCallId, name: 'run_command', kind: 'execute', title: 'echo b', status: 'completed', rawOutput: 'b\n' });
    // Before bindChild, child B's tool was NOT mis-attached to task A.
    const initialDone = ui.find((e): e is Extract<UiEvent, { type: 'item.completed' }> => e.type === 'item.completed' && e.item.id === childCallId);
    expect(initialDone?.item.parentItemId).toBeUndefined();
    // Binding child B repairs the completed child item with a late update.
    tracker.bindChild('call_b', childB);
    events.reparentTools(id => parseChildToolCallId(id)?.childId === childB, 'call_b');
    const reparented = ui.filter((e): e is Extract<UiEvent, { type: 'item.updated' }> => e.type === 'item.updated' && e.item.id === childCallId).at(-1);
    expect(reparented).toMatchObject({ type: 'item.updated', late: true, item: { id: childCallId, parentItemId: 'call_b', output: 'b\n' } });
  });

  it('preserves declined status on a killed subagent when the parent turn is later cancelled', () => {
    const tracker = new AntigravitySubagentTracker();
    const ui: UiEvent[] = [];
    const events = new AcpEvents({ uiEvent: event => ui.push(event) }, antigravityWireHooks(tracker));
    events.begin();
    const args = { TypeName: 'self', Role: 'Worker', Prompt: 'Run' };
    events.update({ sessionUpdate: 'tool_call', toolCallId: 'call_sub', name: 'invoke_subagent', kind: 'other', title: 'Run invoke_subagent', status: 'in_progress', rawInput: args });
    events.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_sub', name: 'invoke_subagent', kind: 'other', title: 'Run invoke_subagent', status: 'completed', rawInput: args });
    const childId = '33333333-3333-4333-8333-333333333333';
    tracker.bindChild('call_sub', childId);
    events.update({ sessionUpdate: 'tool_call', toolCallId: 'call_kill', name: 'manage_subagents', kind: 'other', title: 'Run manage_subagents', status: 'in_progress', rawInput: { Action: 'kill', ConversationIds: [childId] } });
    events.update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_kill', name: 'manage_subagents', kind: 'other', title: 'Run manage_subagents', status: 'completed', rawInput: { Action: 'kill', ConversationIds: [childId] } });
    events.finish('cancelled');
    const completions = ui.filter((e): e is Extract<UiEvent, { type: 'item.completed' }> => e.type === 'item.completed' && e.item.id === 'call_sub');
    expect(completions).toHaveLength(1);
    expect(completions[0]?.item).toMatchObject({ id: 'call_sub', status: 'declined', output: 'Stopped by parent' });
  });

  it('maps the live CLI 1.5.18 child transcript into nested items while deduplicating ACP-forwarded tools', async () => {
    const childId = '7bb3c467-2cb1-4fdc-a962-db063faac0e6';
    const parentId = 'call_5311290449871908198';
    const lines = (await readFile(new URL('cli-subagent-1.5.18.child.transcript.jsonl', fixtures), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const planned = new Map<number, { name: string; args: unknown }>();
    const seen = new Set<number>();
    let wireEchoConsumed = false;
    const events: UiEvent[] = [];
    for (const row of lines) {
      events.push(...mapChildTranscriptRow(row, childId, parentId, planned, seen, name => {
        if (name === 'run_command' && !wireEchoConsumed) { wireEchoConsumed = true; return true; }
        return false;
      }));
    }
    expect(wireEchoConsumed).toBe(true);
    const completed = events.flatMap(event => event.type === 'item.completed' ? [event.item] : []);
    expect(completed.every(item => item.parentItemId === parentId)).toBe(true);
    expect(completed.some(item => item.kind === 'reasoning' && item.text.includes('Target file content retrieval'))).toBe(true);
    expect(completed.some(item => item.kind === 'tool' && item.name === 'Read' && item.output?.includes('hello from sample file'))).toBe(true);
    expect(completed.some(item => item.kind === 'tool' && item.name === 'send_message')).toBe(true);
    expect(completed.some(item => item.kind === 'message' && item.text === 'Reported results to the parent agent.')).toBe(true);
    expect(completed.some(item => item.kind === 'tool' && item.name === 'Bash')).toBe(false);
  });

  it('recovers empty ACP-forwarded child MCP tool outputs from the child transcript without duplicating them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antigravity-child-mcp-')); dirs.push(dir);
    const path = join(dir, 'transcript_full.jsonl');
    const events: UiEvent[] = [];
    const childId = '7bb3c467-2cb1-4fdc-a962-db063faac0e6';
    const tailer = new AntigravityChildTranscripts(event => events.push(event));
    const mcpArgs = { query: 'status' };
    const wireId1 = `${childId}:call_mcp_1`;
    const wireId2 = `${childId}:call_mcp_2`;
    // Order 1: wire completes empty BEFORE child transcript row is read.
    tailer.recordWireTool(childId, wireId1, 'mcp_demo_lookup', mcpArgs);
    // oxlint-disable-next-line cez/test-enum-literal -- UI tool status is independent of run status.
    const wireItem1: UiToolItem = { kind: 'tool', id: wireId1, parentItemId: 'call_parent', name: 'mcp_demo_lookup', toolKind: 'other', title: 'lookup', status: 'completed', input: mcpArgs };
    tailer.completedWireTool(childId, wireItem1);
    // Order 2: child transcript row is read BEFORE wire completes empty.
    tailer.recordWireTool(childId, wireId2, 'mcp_demo_lookup', { query: 'second' });
    tailer.openChild(childId, 'call_parent', path);
    await writeFile(path, [
      JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'mcp_demo_lookup', args: mcpArgs }, { name: 'mcp_demo_lookup', args: { query: 'second' } }] }),
      JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Created At: now\nCompleted At: now\n{"ok":true,"first":1}' }),
      JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE', content: 'Created At: now\nCompleted At: now\n{"ok":true,"second":2}' }),
    ].join('\n') + '\n');
    await tailer.poll();
    // oxlint-disable-next-line cez/test-enum-literal -- UI tool status is independent of run status.
    const wireItem2: UiToolItem = { kind: 'tool', id: wireId2, name: 'mcp_demo_lookup', toolKind: 'other', title: 'lookup', status: 'completed', input: { query: 'second' } };
    tailer.completedWireTool(childId, wireItem2);
    tailer.close();
    // No duplicate item.completed emitted for either forwarded MCP tool; both amended via late item.updated.
    expect(events.filter(event => event.type === 'item.completed')).toEqual([]);
    expect(events).toEqual([
      { type: 'item.updated', late: true, item: expect.objectContaining({ id: wireId1, parentItemId: 'call_parent', output: '{"ok":true,"first":1}' }) },
      { type: 'item.updated', late: true, item: expect.objectContaining({ id: wireId2, parentItemId: 'call_parent', output: '{"ok":true,"second":2}' }) },
    ]);
  });

  it('keeps tailing appended child rows across polls and flushes cleanly before closing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'antigravity-child-')); dirs.push(dir);
    const path = join(dir, 'transcript_full.jsonl');
    const events: UiEvent[] = [];
    const childId = '7bb3c467-2cb1-4fdc-a962-db063faac0e6';
    const tailer = new AntigravityChildTranscripts(event => events.push(event));
    tailer.recordWireTool(childId, `${childId}:call_1`, 'run_command', { CommandLine: 'echo hi' });
    tailer.openChild(childId, 'call_parent', path);
    await writeFile(path, `${JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: { Path: '/work/a.txt' } }, { name: 'run_command', args: { CommandLine: 'echo hi' } }] })}\n`);
    await tailer.poll();
    await appendFile(path, [
      JSON.stringify({ step_index: 2, type: 'GENERIC', status: 'DONE', content: 'Created At: now\nCompleted At: now\n1: file text' }),
      JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'DONE', content: 'hi' }),
    ].join('\n') + '\n');
    await tailer.poll();
    // Later rows appended after an earlier message still stream until explicit close/kill.
    await appendFile(path, `${JSON.stringify({ step_index: 4, type: 'SYSTEM_MESSAGE', source: 'SYSTEM_SDK', status: 'DONE', content: '<SYSTEM_MESSAGE>\nThe following system message was injected by a SessionStart hook:\nchild hook note\n</SYSTEM_MESSAGE>' })}\n`);
    await tailer.closeChild(childId);
    tailer.close();
    const completed = events.flatMap(event => event.type === 'item.completed' ? [event.item] : []);
    expect(completed).toEqual([
      expect.objectContaining({ kind: 'tool', parentItemId: 'call_parent', name: 'Read', title: 'Read /work/a.txt', output: '1: file text' }),
      expect.objectContaining({ kind: 'hook', parentItemId: 'call_parent', event: 'SessionStart' }),
    ]);
  });
});
