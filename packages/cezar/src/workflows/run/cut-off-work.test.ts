import { describe, expect, it } from 'vitest';
import { cutOffWork, recordCutOffWork, withCutOff, type CutOffWork } from './cut-off-work.ts';

// hearsay-tools/squawk#3909: the resume after a restart names the work the restart cut off, from
// Squawk's own event log, the same on every runner.
const tool = (id: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'item.updated', item: { kind: 'tool', id, name: 'Bash', toolKind: 'execute', title: `Ran ${id}`, status, ...extra } });
const turn = { type: 'turn.started', turnId: 't' };

describe('cutOffWork', () => {
  it('names the last turn\'s open root calls and every background subagent still running', () => {
    const events = [
      tool('old-agent', 'running', { name: 'Agent', title: 'Docs sweep', background: true }),
      tool('stale', 'running'),
      turn,
      tool('done', 'completed'),
      tool('prepr', 'running'),
      tool('child', 'running', { parentItemId: 'old-agent' }),
      tool('spawn', 'running', { name: 'Agent', title: 'Lint sweep' }),
      tool('spawn', 'running', { name: 'Agent', title: 'Lint sweep', background: true }),
    ];
    expect(cutOffWork(events)).toEqual({ tools: ['Bash: Ran prepr'], subagents: ['Agent: Docs sweep', 'Agent: Lint sweep'] });
  });

  it('names nothing when every call has its result', () => {
    expect(cutOffWork([turn, tool('a', 'completed'), tool('b', 'failed'), tool('c', 'running', { background: true }), tool('c', 'completed', { background: true })])).toBeUndefined();
  });

  it('caps the list and shortens a long title', () => {
    const many = Array.from({ length: 8 }, (_, i) => tool(`t${i}`, 'running'));
    expect(cutOffWork([turn, ...many])!.tools).toEqual(['Bash: Ran t0', 'Bash: Ran t1', 'Bash: Ran t2', 'Bash: Ran t3', 'Bash: Ran t4', '3 more']);
    const long = cutOffWork([turn, tool('x', 'running', { title: 'y'.repeat(300) })])!.tools![0]!;
    expect(long.length).toBe(120);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('recordCutOffWork', () => {
  const logOf = (events: unknown[]) => ({
    readEvents: () => [...events],
    appendEvent: (_runId: string, event: { type: string }) => { events.push(event); return event; },
  });

  it('ends each cut-off item as declined, so a later restart names nothing again', () => {
    const events: unknown[] = [tool('agent', 'running', { name: 'Agent', title: 'Docs sweep', background: true }), turn, { ...tool('prepr', 'running'), stepId: 'task' }];
    const log = logOf(events);
    expect(recordCutOffWork(log, 'run')).toEqual({ tools: ['Bash: Ran prepr'], subagents: ['Agent: Docs sweep'] });
    expect(events.slice(3)).toEqual([
      { type: 'item.completed', stepId: 'task', item: expect.objectContaining({ id: 'prepr', status: 'declined' }) },
      { type: 'item.completed', item: expect.objectContaining({ id: 'agent', status: 'declined', background: true }) },
    ]);
    // A second restart, after a new turn of a new process.
    events.push(turn);
    expect(recordCutOffWork(log, 'run')).toBeUndefined();
  });

  it('a first restart with no checkpoint still names the work; an existing name list stays', () => {
    const log = logOf([turn, tool('prepr', 'running')]);
    expect(withCutOff(log, 'run', { restarted: true })).toEqual({ restarted: true, cutOff: { tools: ['Bash: Ran prepr'] } });
    expect(withCutOff(logOf([turn, tool('x', 'completed')]), 'run', { restarted: true, cutOff: { tools: ['kept'] } })).toEqual({ restarted: true, cutOff: { tools: ['kept'] } });
    expect(withCutOff(logOf([turn, tool('x', 'running')]), 'run', {})).toEqual({});
  });
});

it('a second crash in the resumed turn replaces the names the checkpoint still holds', () => {
  const events: unknown[] = [turn, tool('a', 'running')];
  const log = { readEvents: () => [...events], appendEvent: (_runId: string, event: { type: string }) => { events.push(event); return event; } };
  const start: { restarted: true; cutOff?: CutOffWork } = { restarted: true };
  const first = withCutOff(log, 'run', start);
  expect(first.cutOff).toEqual({ tools: ['Bash: Ran a'] });
  // The same restart's second call finds the items closed and keeps the names.
  expect(withCutOff(log, 'run', first)).toEqual(first);
  events.push(turn, tool('b', 'running'));
  expect(withCutOff(log, 'run', first).cutOff).toEqual({ tools: ['Bash: Ran b'] });
});
