import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiToolItem } from '../../core/ui-events.ts';
import { AntigravityToolOutputs, AntigravityTranscript, TRANSCRIPT_OUTPUT_CHARS, TRANSCRIPT_WAIT_MS, antigravityTranscriptPath, transcriptCall, transcriptResultText } from './tool-transcript.ts';

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
    for (const update of await wireUpdates()) {
      const call = transcriptCall(update);
      if (call) outputs[call.id] = { name: call.name, output: transcript.output(call) ?? null };
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
});
