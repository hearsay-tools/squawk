import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiHookItem, UiToolItem } from '../../core/ui-events.ts';
import { AntigravityToolOutputs, AntigravityTranscript, TRANSCRIPT_OUTPUT_CHARS, TRANSCRIPT_WAIT_MS, antigravityTranscriptPath, transcriptCall, transcriptHookItem, transcriptResultText } from './tool-transcript.ts';

const fixtures = new URL('./__fixtures__/', import.meta.url);
const fixtureLines = async (name: string) => (await readFile(new URL(name, fixtures), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
const wireUpdates = async () => (await fixtureLines('cli-tool-output.ndjson'))
  .flatMap(line => { const update = (line.frame as { params?: { update?: Record<string, unknown> } }).params?.update; return update ? [update] : []; });
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function transcriptFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'antigravity-transcript-')); dirs.push(dir);
  return join(dir, 'transcript_full.jsonl');
}
const rows = (...values: unknown[]) => `${values.map(value => JSON.stringify(value)).join('\n')}\n`;
const readArgs = { Path: '/work/project/notes.txt' };
const readUpdate = { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', name: 'read_file', args: readArgs, status: 'completed', kind: 'read', title: 'File notes.txt', rawInput: readArgs };
const readItem: UiToolItem = { kind: 'tool', id: 'call_1', name: 'Read', title: 'File notes.txt', toolKind: 'read', status: 'completed', input: readArgs };
const planner = (step: number) => ({ step_index: step, type: 'PLANNER_RESPONSE', status: 'DONE', tool_calls: [{ name: 'read_file', args: readArgs }] });
const result = (step: number, text: string) => ({ step_index: step, type: 'GENERIC', status: 'DONE', content: `Created At: 2026-11-22T21:27:12+01:00\nCompleted At: 2026-11-22T21:27:12+01:00\n${text}` });

describe('the Antigravity CLI transcript as the source of tool results', () => {
  it('gives every result-less tool of the recorded wire the text its transcript row holds', async () => {
    const transcript = new AntigravityTranscript();
    for (const row of await fixtureLines('cli-tool-output.transcript.jsonl')) transcript.addRow(row);
    const outputs: Record<string, { name: string; output: string | null }> = {};
    const started = new Set<string>();
    for (const update of await wireUpdates()) {
      const id = update.toolCallId as string | undefined;
      if (id && !started.has(id)) { started.add(id); transcript.start({ id, name: update.name as string, args: update.args }); }
      const call = transcriptCall(update);
      if (call) outputs[call.id] = { name: call.name, output: transcript.output(call.id) ?? null };
    }
    expect(outputs).toStrictEqual(JSON.parse(await readFile(new URL('cli-tool-output.outputs.json', fixtures), 'utf8')));
    // A read, an MCP result, an MCP failure and the denied subagent call each carry what the agent received.
    expect(Object.values(outputs).map(({ name }) => name)).toEqual(['read_file', 'mcp_probe_echo', 'read_file', 'mcp_probe_fail', 'invoke_subagent']);
  });

  it('waits only for terminal updates that carry no result', () => {
    expect(transcriptCall(readUpdate)).toEqual({ id: 'call_1', name: 'read_file', args: readArgs });
    expect(transcriptCall({ ...readUpdate, status: 'in_progress' })).toBeUndefined();
    expect(transcriptCall({ ...readUpdate, rawOutput: { output: 'ok' } })).toBeUndefined();
    expect(transcriptCall({ ...readUpdate, content: [{ type: 'diff', path: 'a', newText: 'b' }] })).toBeUndefined();
  });

  it('bounds a long result', () => {
    const text = transcriptResultText({ step_index: 1, type: 'GENERIC', content: 'x'.repeat(TRANSCRIPT_OUTPUT_CHARS + 10) });
    expect(text).toBe(`${'x'.repeat(TRANSCRIPT_OUTPUT_CHARS)}\n… (output truncated by Squawk)`);
  });

  it('names the transcript inside the run\'s own account folder and session', () => {
    expect(antigravityTranscriptPath('/accounts/work', 'session-1')).toBe(join('/accounts/work', 'antigravity-cli', 'brain', 'session-1', '.system_generated', 'logs', 'transcript_full.jsonl'));
  });

  it('amends a completed tool when its row lands after the wire update, reading only rows written since the session opened', async () => {
    const path = await transcriptFile();
    // A resumed session: the earlier run read the same file, and that row must not answer this call.
    await writeFile(path, rows(planner(0), result(1, 'old content')));
    let amend!: (item: UiToolItem) => void;
    const amended = new Promise<UiToolItem>(resolve => { amend = resolve; });
    const outputs = new AntigravityToolOutputs(item => amend(item));
    outputs.open(path);
    outputs.observe(readUpdate);
    outputs.completed(readItem);
    await outputs.poll();
    await appendFile(path, rows(planner(2), result(3, '1: new content')));
    await outputs.poll();
    expect(await amended).toEqual({ ...readItem, output: '1: new content' });
    outputs.close();
  });

  it('gives identical calls their own rows when they complete out of order', () => {
    const transcript = new AntigravityTranscript();
    transcript.start({ id: 'first', name: 'read_file', args: readArgs });
    transcript.start({ id: 'second', name: 'read_file', args: readArgs });
    transcript.addRow({ step_index: 0, type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: readArgs }, { name: 'read_file', args: readArgs }] });
    transcript.addRow(result(1, 'first content'));
    transcript.addRow(result(2, 'second content'));
    expect(transcript.output('second')).toBe('second content');
    expect(transcript.output('first')).toBe('first content');
  });

  it('keeps an expired call\'s slot, so a later identical call never shows its late row', async () => {
    const path = await transcriptFile();
    const amended: UiToolItem[] = [];
    let now = 0;
    const outputs = new AntigravityToolOutputs(item => amended.push(item), () => now);
    outputs.open(path);
    outputs.observe(readUpdate); outputs.completed(readItem);
    now = TRANSCRIPT_WAIT_MS + 1;
    await outputs.poll();
    // The first read's rows land after its wait ended; the agent then reads the edited file again.
    await writeFile(path, rows(planner(0), result(1, 'old content')));
    const again = { ...readUpdate, toolCallId: 'call_2' };
    outputs.observe(again); outputs.completed({ ...readItem, id: 'call_2' });
    await outputs.poll();
    await appendFile(path, rows(planner(2), result(3, 'new content')));
    await outputs.poll();
    expect(amended).toEqual([{ ...readItem, id: 'call_2', output: 'new content' }]);
    outputs.close();
  });

  it('leaves the tool without output when the transcript is missing, its rows changed format, or the wait ends', async () => {
    const amend = vi.fn();
    let now = 0;
    const missing = new AntigravityToolOutputs(amend, () => now);
    missing.open(join(await transcriptFile(), 'absent.jsonl'));
    missing.observe(readUpdate); missing.completed(readItem);
    await expect(missing.poll()).resolves.toBeUndefined();

    const path = await transcriptFile();
    const changed = new AntigravityToolOutputs(amend, () => now);
    changed.open(path);
    changed.observe(readUpdate); changed.completed(readItem);
    await writeFile(path, `not json\n${rows({ step: 0, kind: 'planner', calls: [{ tool: 'read_file' }] }, { step: 1, text: 'other format' })}`);
    await changed.poll();
    // The wait ends: a row written later no longer amends the card.
    now = TRANSCRIPT_WAIT_MS + 1;
    await appendFile(path, rows(planner(2), result(3, 'too late')));
    changed.completed(readItem);
    await changed.poll();
    expect(amend).not.toHaveBeenCalled();
    missing.close(); changed.close();
  });

  it('maps live SYSTEM_SDK hook rows to its exact expected hook items and ignores internal SYSTEM reminders', async () => {
    const transcript = new AntigravityTranscript();
    for (const row of await fixtureLines('cli-hooks.transcript.jsonl')) transcript.addRow(row);
    const events = transcript.drainHooks().map(item => ({ type: 'item.completed', item }));
    expect(events).toStrictEqual(JSON.parse(await readFile(new URL('cli-hooks.expected.json', fixtures), 'utf8')));
  });

  it('bounds long hook text, maps failed hooks, skips silent or non-hook rows, and deduplicates by step_index', () => {
    const long = transcriptHookItem({
      step_index: 5, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', status: 'DONE',
      content: `<SYSTEM_MESSAGE>\nThe following system message was injected by a postInvocation hook:\n${'h'.repeat(TRANSCRIPT_OUTPUT_CHARS + 5)}\n</SYSTEM_MESSAGE>`,
    });
    expect(long).toEqual({
      kind: 'hook', id: 'hook_step_5', event: 'PostInvocation', status: 'completed',
      entries: [{ kind: 'context', text: `${'h'.repeat(TRANSCRIPT_OUTPUT_CHARS)}\n… (output truncated by Squawk)` }],
    });
    const failed = transcriptHookItem({
      step_index: 6, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', status: 'ERROR', error: 'hook timed out',
      content: '<SYSTEM_MESSAGE>\nThe following system message was injected by a Stop hook:\n\n</SYSTEM_MESSAGE>',
    });
    expect(failed).toEqual({
      // oxlint-disable-next-line cez/test-enum-literal -- HookStatus on UiHookItem, not a contract run or step status.
      kind: 'hook', id: 'hook_step_6', event: 'Stop', status: 'failed',
      entries: [{ kind: 'error', text: 'hook timed out' }],
    });
    expect(transcriptHookItem({
      step_index: 7, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', status: 'DONE',
      content: '<SYSTEM_MESSAGE>\nThe following system message was injected by a SessionStart hook:\n   \n</SYSTEM_MESSAGE>',
    })).toBeUndefined();
    expect(transcriptHookItem({
      step_index: 8, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE',
      content: '<SYSTEM_MESSAGE>\nThe following system message was injected by a SessionStart hook:\nspoofed\n</SYSTEM_MESSAGE>',
    })).toBeUndefined();
    expect(transcriptHookItem({
      step_index: 9, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', status: 'DONE',
      content: '<SYSTEM_MESSAGE>\nNot a hook header\n</SYSTEM_MESSAGE>',
    })).toBeUndefined();

    const transcript = new AntigravityTranscript();
    const row = {
      step_index: 1, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', status: 'DONE',
      content: '<SYSTEM_MESSAGE>\nThe following system message was injected by a SessionStart hook:\nonce\n</SYSTEM_MESSAGE>',
    };
    transcript.addRow(row);
    transcript.addRow(row);
    expect(transcript.drainHooks()).toHaveLength(1);
    expect(transcript.drainHooks()).toEqual([]);
  });

  it('emits hooks appended after session open with no pending tool call', async () => {
    const path = await transcriptFile();
    await writeFile(path, rows({
      step_index: 0, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', status: 'DONE',
      content: '<SYSTEM_MESSAGE>\nThe following system message was injected by a SessionStart hook:\nfrom prior session\n</SYSTEM_MESSAGE>',
    }));
    const hooks: UiHookItem[] = [];
    const outputs = new AntigravityToolOutputs(() => {}, Date.now, hook => hooks.push(hook));
    outputs.open(path);
    await outputs.poll();
    expect(hooks).toEqual([]);
    await appendFile(path, rows({
      step_index: 4, source: 'SYSTEM_SDK', type: 'SYSTEM_MESSAGE', status: 'DONE',
      content: '<SYSTEM_MESSAGE>\nThe following system message was injected by a PreInvocation hook:\nSQUEAL · updated\n</SYSTEM_MESSAGE>',
    }));
    await outputs.poll();
    expect(hooks).toEqual([{
      kind: 'hook', id: 'hook_step_4', event: 'PreInvocation', status: 'completed',
      entries: [{ kind: 'context', text: 'SQUEAL · updated' }],
    }]);
    outputs.close();
  });
});
