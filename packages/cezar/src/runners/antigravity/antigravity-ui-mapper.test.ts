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

describe('Antigravity 1.5.0 recorded ACP wire', () => {
  for (const file of readdirSync(fixtures).filter(name => name.endsWith('.ndjson'))) {
    const name = file.slice(0, -'.ndjson'.length);
    it(`maps ${name} to its exact events`, () => {
      const expected = JSON.parse(readFileSync(new URL(`${name}.expected.json`, fixtures), 'utf8'));
      expect(replay(name)).toStrictEqual(expected);
    });
  }

  it('keeps concurrent prompt acknowledgements inside the original turn', () => {
    const events = replay('midturn-prompt');
    expect(events.filter(event => event.type === 'turn.started')).toHaveLength(1);
    expect(events.filter(event => event.type === 'turn.completed')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('Concurrent receive_steps()');
  });

  it('maps the execution error text plus end_turn to a failed turn', () => {
    expect(replay('model-error').filter(event => event.type === 'turn.completed')).toEqual([
      { type: 'turn.completed', turnId: 'acp-turn-1', stopReason: 'error' },
    ]);
  });

  it('retains native subagent arguments when an empty progress update follows', () => {
    const completed = replay('subagent').filter(event => event.type === 'item.completed');
    expect(completed).toContainEqual(expect.objectContaining({ item: expect.objectContaining({
      toolKind: 'task', status: 'completed', input: expect.objectContaining({ Subagents: expect.any(Array) }),
    }) }));
  });
});
