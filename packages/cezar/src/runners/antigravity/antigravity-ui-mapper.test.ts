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

  it('closes a cancelled command once, before its late failed update', () => {
    const events = replay('cli-cancel');
    expect(events.find(event => event.type === 'turn.completed')).toMatchObject({ stopReason: 'cancelled' });
    expect(closedTwice(events)).toEqual([]);
  });

  it('names a squawk MCP item by the tool part of mcp_squawk_<tool>', () => {
    const tools = replay('cli-mcp-two-turn').flatMap(event => event.type === 'item.started' && event.item.kind === 'tool' ? [event.item.name] : []);
    expect(tools[0]).toBe('echo');
  });

  it('retains native subagent arguments when an empty progress update follows', () => {
    const completed = replay('cli-subagent').filter(event => event.type === 'item.completed');
    expect(completed).toContainEqual(expect.objectContaining({ item: expect.objectContaining({ toolKind: 'task', status: 'completed' }) }));
  });
});
