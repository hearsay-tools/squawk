import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { UiEvent } from '../../core/ui-events.ts';
import { createAntigravityUiState, mapAntigravityFrame } from './antigravity-ui-mapper.ts';

const fixtures = new URL('./__fixtures__/', import.meta.url);
function replay(name: string): UiEvent[] {
  let state = createAntigravityUiState();
  const events: UiEvent[] = [];
  for (const line of readFileSync(new URL(`${name}.ndjson`, fixtures), 'utf8').trim().split('\n')) {
    const mapped = mapAntigravityFrame(JSON.parse(line), state);
    state = mapped.state;
    events.push(...mapped.events);
  }
  return JSON.parse(JSON.stringify(events)) as UiEvent[];
}

describe('Antigravity CLI recorded ACP wire', () => {
  for (const file of readdirSync(fixtures).filter(name => name.endsWith('.ndjson'))) {
    const name = file.slice(0, -'.ndjson'.length);
    it(`maps ${name} to its exact events`, () => {
      const expected = JSON.parse(readFileSync(new URL(`${name}.expected.json`, fixtures), 'utf8'));
      expect(replay(name)).toStrictEqual(expected);
    });
  }

  const closedTwice = (events: UiEvent[]) => {
    const ids = events.flatMap(event => event.type === 'item.completed' ? [event.item.id] : []);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  };

  it('keeps a steered prompt in one turn and closes its command once', () => {
    const events = replay('cli-midturn-prompt');
    expect(events.filter(event => event.type === 'turn.started')).toHaveLength(1);
    expect(events.filter(event => event.type === 'turn.completed')).toEqual([expect.objectContaining({ stopReason: 'end_turn',
      usage: expect.objectContaining({ total: 12_738 + 13_125 }) })]);
    expect(closedTwice(events)).toEqual([]);
  });

  it.each(['cli-permission-after-turn', 'cli-background-command', 'cli-schedule-timer'])('maps %s work after the turn to its own agent-started turn', name => {
    const events = replay(name);
    const started = events.flatMap((event, index) => event.type === 'turn.started' ? [index] : []);
    const completed = events.flatMap((event, index) => event.type === 'turn.completed' ? [index] : []);
    expect(started.length).toBeGreaterThanOrEqual(2);
    expect(completed).toHaveLength(started.length);
    // Every item lands inside an open turn.
    let open = false;
    for (const event of events) {
      if (event.type === 'turn.started') open = true;
      if (event.type === 'turn.completed') open = false;
      if (event.type.startsWith('item.')) expect(open).toBe(true);
    }
    expect(closedTwice(events)).toEqual([]);
  });

  it('maps the executor error text plus end_turn to a failed turn', () => {
    expect(replay('cli-config-options').filter(event => event.type === 'turn.completed')).toEqual([
      expect.objectContaining({ type: 'turn.completed', stopReason: 'error' }),
    ]);
  });

  /** One prompt turn of synthetic frames: the prompt, the agent's updates, then its end_turn response. */
  function turn(...updates: Array<Record<string, unknown>>): UiEvent[] {
    let state = createAntigravityUiState();
    const events: UiEvent[] = [];
    const frames = [{ from: 'client', frame: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's', prompt: [] } } },
      ...updates.map(update => ({ from: 'agent', frame: { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update } } })),
      { from: 'agent', frame: { jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } } }];
    for (const frame of frames) { const mapped = mapAntigravityFrame(frame, state); state = mapped.state; events.push(...mapped.events); }
    return events;
  }
  const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const stopReason = (events: UiEvent[]) => events.flatMap(event => event.type === 'turn.completed' ? [event.stopReason] : [])[0];

  it('fails the turn on the CLI failure shape with no executor prefix, as the 404 of hearsay-tools/squawk#4098', () => {
    expect(stopReason(turn(chunk('\n⚠ NOT_FOUND (code 404): Requested entity was not found.\n'), { sessionUpdate: 'usage_update', used: 1, size: 2 }))).toBe('error');
  });

  it.each([
    ['a warning inside the reply', [chunk('Checked the logs.\n'), chunk('\n⚠ The 404 above came from Google.\n')]],
    ['a reply that starts with the sign', [chunk('⚠ Careful: this deletes files.')]],
    ['a failure-shaped message the agent keeps working after', [chunk('\n⚠ retrying\n'), { sessionUpdate: 'tool_call', toolCallId: 'c', name: 'read_file', title: 'File a', kind: 'read', status: 'in_progress' }]],
  ])('keeps assistant text with a warning sign as text: %s', (_case, updates) => {
    const events = turn(...updates);
    expect(stopReason(events)).toBe('end_turn');
    expect(events.filter(event => event.type === 'item.delta').map(event => event.type === 'item.delta' ? event.delta : '').join('')).toContain('⚠');
  });

  it('closes a cancelled command once, before its late failed update', () => {
    const events = replay('cli-cancel');
    expect(events.find(event => event.type === 'turn.completed')).toMatchObject({ stopReason: 'cancelled' });
    expect(closedTwice(events)).toEqual([]);
  });

  it('names a squawk MCP item by the tool part of mcp_squawk_<tool>', () => {
    const tools = replay('cli-mcp-two-turn').flatMap(event => event.type === 'item.started' && event.item.kind === 'tool' ? [event.item.name] : []);
    expect(tools[0]).toBe('echo');
  });

  it('nests forwarded CLI 1.5.18 subagent work under invoke_subagent and settles killed subagents as declined', () => {
    const events18 = replay('cli-subagent-1.5.18');
    const startedTask = events18.find(event => event.type === 'item.started' && event.item.kind === 'tool' && event.item.toolKind === 'task');
    const completedTask = events18.find(event => event.type === 'item.completed' && event.item.kind === 'tool' && event.item.toolKind === 'task');
    // oxlint-disable-next-line cez/test-enum-literal -- UI tool status is independent of run status.
    expect(startedTask).toMatchObject({ item: { id: 'call_5311290449871908198', title: 'Task: Shell Runner', status: 'running', input: expect.objectContaining({ subagent_type: 'self' }) } });
    expect(completedTask).toMatchObject({ item: { id: 'call_5311290449871908198', title: 'Task: Shell Runner', status: 'completed' } });
    expect(events18).toContainEqual(expect.objectContaining({
      type: 'item.completed',
      item: expect.objectContaining({ id: '7bb3c467-2cb1-4fdc-a962-db063faac0e6:call_17336341270670134121', parentItemId: 'call_5311290449871908198', name: 'Bash', status: 'completed' }),
    }));
    const completed14 = replay('cli-subagent').filter(event => event.type === 'item.completed');
    expect(completed14).toContainEqual(expect.objectContaining({ item: expect.objectContaining({ toolKind: 'task', title: 'Task: Subagent Runner', status: 'declined' }) }));
  });
});
