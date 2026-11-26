import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UiEvent } from '../../core/ui-events.ts';
import {
  AntigravitySubagentTracker,
  parseChildMessageDelivery,
  parseChildToolCallId,
  parseSpawnedSubagentId,
} from './subagent-tracker.ts';
import { AntigravityChildTranscripts, mapChildTranscriptRow } from './subagent-transcript.ts';

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

  it('tracks parallel subagents by explicit binding, falls back FIFO, and settles on kill or turn end', () => {
    const tracker = new AntigravitySubagentTracker();
    const spawn = (id: string) => ({
      update: { sessionUpdate: 'tool_call_update', toolCallId: id, name: 'invoke_subagent', status: 'completed' },
      item: { kind: 'tool' as const, id, name: 'Task', toolKind: 'task' as const, title: 'Task: Worker', status: 'completed' as const },
    });
    const first = spawn('call_1');
    const second = spawn('call_2');
    expect(tracker.shouldHold(first.update, first.item)).toBe(true);
    expect(tracker.shouldHold(second.update, second.item)).toBe(true);
    // Explicit binding pins second child even if it reports before the first.
    const childA = '11111111-1111-4111-8111-111111111111';
    const childB = '22222222-2222-4222-8222-222222222222';
    tracker.bindChild('call_2', childB);
    expect(tracker.parentForChild(childB)).toBe('call_2');
    // Unbound child claims remaining unbound spawn FIFO.
    expect(tracker.parentForChild(childA)).toBe('call_1');
    // Forking does not mutate the parent tracker.
    const forked = tracker.fork();
    expect(forked.settleOnTurnEnd('cancelled')).toEqual([
      // oxlint-disable-next-line cez/test-enum-literal -- UI tool status is independent of run status.
      { id: 'call_1', status: 'failed' },
      // oxlint-disable-next-line cez/test-enum-literal -- UI tool status is independent of run status.
      { id: 'call_2', status: 'failed' },
    ]);
    expect(tracker.isActive('call_1')).toBe(true);
    // manage_subagents kill settles only the targeted child.
    const killUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'call_kill', name: 'manage_subagents', status: 'completed', rawInput: { Action: 'kill', ConversationIds: [childA] } };
    expect(tracker.afterToolUpdate(killUpdate, { kind: 'tool', id: 'call_kill', name: 'manage_subagents', toolKind: 'other', title: 'Run manage_subagents', status: 'completed' }))
      .toEqual([{ id: 'call_1', status: 'declined', output: 'Stopped by parent' }]);
    // Child reply settles the remaining active child with its summary.
    expect(tracker.settleChild(childB, 'all done')).toEqual({ id: 'call_2', status: 'completed', output: 'all done' });
    expect(tracker.settleOnTurnEnd('end_turn')).toEqual([]);
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
    // Every emitted item carries parentItemId.
    expect(completed.every(item => item.parentItemId === parentId)).toBe(true);
    // Reasoning, non-ACP read_file, send_message, and final reply appear; ACP-forwarded run_command is deduplicated.
    expect(completed.some(item => item.kind === 'reasoning' && item.text.includes('Target file content retrieval'))).toBe(true);
    expect(completed.some(item => item.kind === 'tool' && item.name === 'Read' && item.output?.includes('hello from sample file'))).toBe(true);
    expect(completed.some(item => item.kind === 'tool' && item.name === 'send_message')).toBe(true);
    expect(completed.some(item => item.kind === 'message' && item.text === 'Reported results to the parent agent.')).toBe(true);
    expect(completed.some(item => item.kind === 'tool' && item.name === 'Bash')).toBe(false);
  });

  it('tails appended child transcript rows and flushes cleanly before closing', async () => {
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
      JSON.stringify({ step_index: 4, type: 'SYSTEM_MESSAGE', source: 'SYSTEM_SDK', status: 'DONE', content: '<SYSTEM_MESSAGE>\nThe following system message was injected by a SessionStart hook:\nchild hook note\n</SYSTEM_MESSAGE>' }),
    ].join('\n') + '\n');
    await tailer.flushChild(childId);
    tailer.close();
    const completed = events.flatMap(event => event.type === 'item.completed' ? [event.item] : []);
    expect(completed).toEqual([
      expect.objectContaining({ kind: 'tool', parentItemId: 'call_parent', name: 'Read', title: 'Read /work/a.txt', output: '1: file text' }),
      expect.objectContaining({ kind: 'hook', parentItemId: 'call_parent', event: 'SessionStart' }),
    ]);
  });
});
